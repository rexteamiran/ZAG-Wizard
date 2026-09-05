/** Bindings the wizard worker runs with. */
interface Env {
    /** Encrypts stored panel API keys at rest. */
    readonly SECRET: string;
    /** The wizard's own D1 database: accounts, sessions, connections, profiles. */
    readonly db: D1Database;
    /** Registration gate. Empty or absent keeps sign-up closed. */
    readonly WIZARD_INVITE_CODE?: string;
    readonly ASSETS: any;
}
