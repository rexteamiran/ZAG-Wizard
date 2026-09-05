package internal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"time"

	"github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/accounts"
	"github.com/cloudflare/cloudflare-go/v7/option"
	"github.com/cloudflare/cloudflare-go/v7/pages"
	"github.com/cloudflare/cloudflare-go/v7/workers"
)

type CfAccount struct {
	Token  string
	ID     string
	Email  string
	Client *cloudflare.Client
	// Shared with the SDK so raw REST calls inherit the custom resolver
	// Termux needs.
	HTTP *http.Client
}

func newHTTPClient(useCustomDNS bool) *http.Client {
	if !useCustomDNS {
		return &http.Client{Timeout: 30 * time.Second}
	}
	dnsServers := []string{
		"8.8.8.8:53",
		"1.1.1.1:53",
		"9.9.9.9:53",
		"223.5.5.5:53",
	}

	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 3 * time.Second}
			var lastErr error
			for _, server := range dnsServers {
				conn, err := d.DialContext(ctx, "tcp", server)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, fmt.Errorf("all DNS servers failed: %w", lastErr)
		},
	}

	dialer := &net.Dialer{
		Timeout:  10 * time.Second,
		Resolver: resolver,
	}

	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	}

	return &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}
}

func NewCfAccount(token string) *CfAccount {
	httpClient := newHTTPClient(isTermux)
	client := cloudflare.NewClient(option.WithAPIToken(token), option.WithHTTPClient(httpClient))
	return &CfAccount{
		Token:  token,
		Client: client,
		HTTP:   httpClient,
	}
}

func CreateCfAccount(ctx context.Context, token string) (*CfAccount, error) {
	acc := NewCfAccount(token)

	tokenRes, err := acc.Client.User.Tokens.Verify(ctx)
	if err != nil {
		return nil, err
	}
	if tokenRes.Status != "active" {
		return nil, fmt.Errorf("API token is %s", tokenRes.Status)
	}

	accountsRes, err := acc.Client.Accounts.List(ctx, accounts.AccountListParams{})
	if err != nil {
		return nil, err
	}
	if len(accountsRes.Result) == 0 {
		return nil, fmt.Errorf("this token has no Cloudflare account attached")
	}
	acc.ID = accountsRes.Result[0].ID

	userRes, err := acc.Client.User.Get(ctx)
	if err != nil {
		return nil, err
	}
	acc.Email = userRes.Email

	return acc, nil
}

func (acc *CfAccount) NameTaken(ctx context.Context, deployType, name string) bool {
	var err error
	if deployType == "pages" {
		_, err = acc.Client.Pages.Projects.Get(
			ctx,
			name,
			pages.ProjectGetParams{
				AccountID: cloudflare.F(acc.ID),
			},
		)
		return err == nil
	}

	_, err = acc.Client.Workers.Scripts.Get(
		ctx,
		name,
		workers.ScriptGetParams{
			AccountID: cloudflare.F(acc.ID),
		},
	)

	return err == nil
}

func (acc *CfAccount) GetWorkersDevSubdomain(ctx context.Context) (string, error) {
	subdomain, err := acc.Client.Workers.Subdomains.Get(ctx, workers.SubdomainGetParams{
		AccountID: cloudflare.F(acc.ID),
	})
	if err != nil {
		return "", err
	}

	return subdomain.Subdomain + ".workers.dev", nil
}

func (acc *CfAccount) CreateWorkersDevSubdomain(ctx context.Context) (string, error) {
	maxAttempts := 3
	for range maxAttempts {
		randSub, err := randSubdomain()
		if err != nil {
			return "", err
		}

		if res, err := acc.Client.Workers.Subdomains.Update(ctx, workers.SubdomainUpdateParams{
			AccountID: cloudflare.F(acc.ID),
			Subdomain: cloudflare.F(randSub),
		}); err != nil {
			continue
		} else {
			return res.Subdomain + ".workers.dev", nil
		}
	}
	
	return "", fmt.Errorf("Failed to create a unique workers.dev subdomain after %d attempts.", maxAttempts)
}

// CreateD1Database provisions the usage-accounting database each ZAGROOO
// panel binds as `zag_db`, and returns its uuid.
func (acc *CfAccount) CreateD1Database(ctx context.Context, workerName string) (string, error) {
	body, err := json.Marshal(map[string]string{"name": fmt.Sprintf("%s-zagrooo", workerName)})
	if err != nil {
		return "", err
	}

	endpoint := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/d1/database", acc.ID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+acc.Token)
	req.Header.Set("Content-Type", "application/json")

	res, err := acc.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	var parsed struct {
		Success bool `json:"success"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
		Result struct {
			UUID string `json:"uuid"`
		} `json:"result"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return "", err
	}

	if !parsed.Success || parsed.Result.UUID == "" {
		message := "unknown error"
		if len(parsed.Errors) > 0 {
			message = parsed.Errors[0].Message
		}
		return "", fmt.Errorf("failed to create D1 database: %s", message)
	}

	return parsed.Result.UUID, nil
}

// DeployWorker uploads the panel script with its D1 binding.
//
// This goes over the REST API rather than the Go SDK: the SDK's binding union
// types drift between releases, and a multipart upload is easy enough to build
// by hand.
func (acc *CfAccount) DeployWorker(ctx context.Context, name string, script io.Reader, databaseID string) error {
	bindings := []map[string]string{
		{"type": "d1", "name": "zag_db", "id": databaseID},
	}

	metadata, err := json.Marshal(map[string]any{
		"main_module":         "worker.js",
		"compatibility_date":  time.Now().UTC().Format("2006-01-02"),
		"compatibility_flags": []string{"nodejs_compat"},
		"bindings":            bindings,
	})
	if err != nil {
		return err
	}

	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	metaHeader := make(textproto.MIMEHeader)
	metaHeader.Set("Content-Disposition", `form-data; name="metadata"`)
	metaHeader.Set("Content-Type", "application/json")
	metaPart, err := writer.CreatePart(metaHeader)
	if err != nil {
		return err
	}
	if _, err := metaPart.Write(metadata); err != nil {
		return err
	}

	fileHeader := make(textproto.MIMEHeader)
	fileHeader.Set("Content-Disposition", `form-data; name="worker.js"; filename="worker.js"`)
	fileHeader.Set("Content-Type", "application/javascript+module")
	filePart, err := writer.CreatePart(fileHeader)
	if err != nil {
		return err
	}
	if _, err := io.Copy(filePart, script); err != nil {
		return err
	}

	if err := writer.Close(); err != nil {
		return err
	}

	endpoint := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%s", acc.ID, name)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+acc.Token)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	res, err := acc.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	var parsed struct {
		Success bool `json:"success"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return err
	}

	if !parsed.Success {
		message := "unknown error"
		if len(parsed.Errors) > 0 {
			message = parsed.Errors[0].Message
		}
		return fmt.Errorf("failed to deploy worker: %s", message)
	}

	return nil
}

func (acc *CfAccount) EnableSubdomain(ctx context.Context, subdomain string) error {
	_, err := acc.Client.Workers.Scripts.Subdomain.New(
		ctx,
		subdomain,
		workers.ScriptSubdomainNewParams{
			AccountID: cloudflare.F(acc.ID),
			Enabled:   cloudflare.F(true),
		},
	)
	if err != nil {
		return err
	}

	return nil
}

// CreatePagesProject creates the Pages project with its D1 binding and
// returns the *.pages.dev subdomain.
//
// Over the REST API rather than the Go SDK: the SDK's deployment-config types
// change shape between releases, and getting a binding name wrong there is a
// compile error rather than something the wizard can recover from.
func (acc *CfAccount) CreatePagesProject(ctx context.Context, name, databaseID string) (string, error) {
	production := map[string]any{
		"browsers":            map[string]any{},
		"compatibility_date":  time.Now().UTC().Format("2006-01-02"),
		"compatibility_flags": []string{"nodejs_compat"},
		"d1_databases": map[string]any{
			"zag_db": map[string]string{"id": databaseID},
		},
	}

	body, err := json.Marshal(map[string]any{
		"name":              name,
		"production_branch": "main",
		"deployment_configs": map[string]any{
			"production": production,
		},
	})
	if err != nil {
		return "", err
	}

	endpoint := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/pages/projects", acc.ID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+acc.Token)
	req.Header.Set("Content-Type", "application/json")

	res, err := acc.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	var parsed struct {
		Success bool `json:"success"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
		Result struct {
			Subdomain string `json:"subdomain"`
		} `json:"result"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return "", err
	}

	if !parsed.Success {
		message := "unknown error"
		if len(parsed.Errors) > 0 {
			message = parsed.Errors[0].Message
		}
		return "", fmt.Errorf("failed to create Pages project: %s", message)
	}

	return parsed.Result.Subdomain, nil
}

func (acc *CfAccount) DeployPagesScript(ctx context.Context, name string, script io.Reader) error {
	_, er := acc.Client.Pages.Projects.Deployments.New(
		ctx,
		name,
		pages.ProjectDeploymentNewParams{
			AccountID: cloudflare.F(acc.ID),
			Branch:    cloudflare.F("main"),
			Manifest:  cloudflare.F("{}"),
			WorkerJS:  cloudflare.F(script),
		},
	)
	if er != nil {
		return er
	}

	return nil
}
