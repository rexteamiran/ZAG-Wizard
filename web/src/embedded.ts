/* ==========================================================================
   Reading a deployed panel's embedded settings

   A panel's identity — its secure path, UUID and Trojan password — lives only
   inside the deployed script. The wizard needs it to update a panel, attach
   D1, or rebuild its links.

   The catch is that the object gets written two different ways:

     const EMBEDED_SETTINGS = {…};              ← wizard install (script.ts)
     Object.assign(globalThis, {"EMBEDED_SETTINGS":{…}, …})
                                                ← panel saving settings or
                                                  self-updating (main.ts)

   `buildScript` runs on *any* settings save in the panel's own UI, so the
   second form is the common case for a panel that has been used at all.
   Matching only the first meant that the moment an operator saved anything,
   the wizard could never manage that panel again.
   ========================================================================== */

/** Reads one balanced `{…}` starting at `start`, respecting strings. */
function readObject(source: string, start: number): string | null {
    if (source[start] !== '{') return null;

    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;

    for (let i = start; i < source.length; i++) {
        const char = source[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) inString = false;
            continue;
        }

        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            continue;
        }

        if (char === '{') depth++;
        else if (char === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }

    return null;
}

/**
 * Extracts EMBEDED_SETTINGS from a deployed panel script, whichever form it
 * was written in. Returns `{}` when the script carries none.
 *
 * Brace matching rather than a lazy regex, because the object is nested in the
 * `Object.assign` form and sits beside megabytes of base64 asset blobs.
 */
export function parseEmbeddedSettings(source: string): Record<string, any> {
    const patterns = [
        // const EMBEDED_SETTINGS = {…}
        /EMBEDED_SETTINGS\s*=\s*\{/g,
        // "EMBEDED_SETTINGS":{…}  (also EMBEDED_SETTINGS:{…} after minifying)
        /["']?EMBEDED_SETTINGS["']?\s*:\s*\{/g
    ];

    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(source)) !== null) {
            const braceAt = match.index + match[0].length - 1;
            const body = readObject(source, braceAt);
            if (!body) continue;

            try {
                const parsed = JSON.parse(body);
                // A panel's settings always carry a secure path; anything else
                // matching the name is not what we are looking for.
                if (parsed && typeof parsed === 'object' && parsed.securePath) return parsed;
            } catch (error) {
                // Not JSON — keep looking.
            }
        }
    }

    return {};
}
