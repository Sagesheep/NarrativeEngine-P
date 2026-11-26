import { describe, expect, it } from "vitest";
import { BUILTIN_IDS } from "../../../services/payload/contributions/builtins";
import { blockTokenCap } from "../../../services/turn/blockEnablement";
import { migrateSettings } from "../settingsHelpers";

describe("module token caps", () => {
    it("absent means the declared default", () => {
        expect(blockTokenCap(BUILTIN_IDS.stance, 1200, undefined)).toBe(1200);
    });

    it("uses an explicit persisted value", () => {
        expect(blockTokenCap(BUILTIN_IDS.stance, 1200, { [BUILTIN_IDS.stance]: 3000 })).toBe(3000);
    });

    it("clamps persisted values to the declared range and rejects invalid values", () => {
        expect(blockTokenCap(BUILTIN_IDS.stance, 1200, { [BUILTIN_IDS.stance]: 999999 })).toBe(8000);
        expect(blockTokenCap(BUILTIN_IDS.stance, 1200, { [BUILTIN_IDS.stance]: 0 })).toBe(1200);
        expect(blockTokenCap(BUILTIN_IDS.stance, 1200, { [BUILTIN_IDS.stance]: -1 })).toBe(1200);
        expect(blockTokenCap(BUILTIN_IDS.stance, 1200, { [BUILTIN_IDS.stance]: Number.NaN })).toBe(1200);
    });

    it("sanitises junk and unknown module keys without throwing", () => {
        const settings = migrateSettings({ endpoint: "http://localhost:11434/v1", modelName: "llama3", moduleTokens: { [BUILTIN_IDS.stance]: "abc", [BUILTIN_IDS.directorBrief]: Number.NaN, staleModule: 3000 } });
        expect(settings.moduleTokens).toEqual({});
    });

    it("round-trips an explicit cap through persisted settings", () => {
        const first = migrateSettings({ endpoint: "http://localhost:11434/v1", modelName: "llama3", moduleTokens: { [BUILTIN_IDS.stance]: 3000 } });
        const reloaded = migrateSettings(JSON.parse(JSON.stringify(first)));
        expect(reloaded.moduleTokens).toEqual({ [BUILTIN_IDS.stance]: 3000 });
    });
    it("keeps a blank provider output ceiling absent across reload", () => {
        const settings = migrateSettings({
            providers: [{
                id: "provider-1",
                endpoint: "http://localhost:11434/v1",
                modelName: "llama3",
                maxOutputTokens: undefined,
            }],
        });
        expect(settings.providers[0]).not.toHaveProperty("maxOutputTokens");

        const reloaded = migrateSettings(JSON.parse(JSON.stringify(settings)));
        expect(reloaded.providers[0]).not.toHaveProperty("maxOutputTokens");
    });

});
