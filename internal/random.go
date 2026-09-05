package internal

import (
	crand "crypto/rand"
	"fmt"
	"math/big"
	"strings"
)

func randInt(min, max int) int {
	length, err := randInt64(int64(min), int64(max))
	if err != nil {
		return min
	}
	return int(length)
}

// randInt64 draws uniformly from [min, max] with the cryptographic source, so
// panel credentials never depend on math/rand.
func randInt64(min, max int64) (int64, error) {
	if max < min {
		max = min
	}
	span := big.NewInt(max - min + 1)
	n, err := crand.Int(crand.Reader, span)
	if err != nil {
		return 0, err
	}
	return n.Int64() + min, nil
}

func randString(charset string, minLen, maxLen int) string {
	length := randInt(minLen, maxLen)
	var builder strings.Builder
	builder.Grow(length)
	for i := 0; i < length; i++ {
		idx := randInt(0, len(charset)-1)
		builder.WriteByte(charset[idx])
	}

	return builder.String()
}

func randSubdomain() (string, error) {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789-"
	for {
		subdomain := randString(charset, 16, 32)
		if !strings.HasPrefix(subdomain, "-") && !strings.HasSuffix(subdomain, "-") {
			return subdomain, nil
		}
	}
}

func randCode() string {
	const minVars, maxVars = 50, 500
	const minFuncs, maxFuncs = 50, 500
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	varCount := randInt(minVars, maxVars)
	funcCount := randInt(minFuncs, maxFuncs)

	var varsBuilder strings.Builder
	for i := range varCount {
		varName := fmt.Sprintf("__var_%s_%d", randString(charset, 8, 16), i)
		value := randInt(0, 99999)
		varsBuilder.WriteString(fmt.Sprintf("let %s = %d;\n", varName, value))
	}

	var funcsBuilder strings.Builder
	for i := range funcCount {
		funcName := fmt.Sprintf("__func_%s_%d", randString(charset, 8, 16), i)
		value := randInt(0, 999)
		fmt.Fprintf(&funcsBuilder, "function %s() { return %d; }\n", funcName, value)
	}

	return varsBuilder.String() + funcsBuilder.String()
}
