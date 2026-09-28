import { describe, expect, it, vi, beforeEach } from "vitest";

const sendCommand = vi.fn();

vi.mock("../src/utils/ConnectionManager.js", () => ({
  withApplicationConnection: async (fn: (client: { sendCommand: typeof sendCommand }) => unknown) => await fn({ sendCommand }),
}));

const {
  PROFILE_DOMAIN_DEFINITION,
  ProfileCheckKValuesArgsSchema,
  ProfileViewCreateArgsSchema,
} = await import("../src/tools/domains/profileDomain.js");

describe("civil3d_profile check_k_values schema", () => {
  const base = { action: "check_k_values", alignmentName: "Main St", profileName: "FG", designSpeed: 50 };

  it("accepts mph and km/h speed units and leaves them optional", () => {
    expect(ProfileCheckKValuesArgsSchema.safeParse(base).success).toBe(true);
    expect(ProfileCheckKValuesArgsSchema.safeParse({ ...base, speedUnits: "mph" }).success).toBe(true);
    expect(ProfileCheckKValuesArgsSchema.safeParse({ ...base, speedUnits: "km/h" }).success).toBe(true);
  });

  it("rejects other speed units", () => {
    expect(ProfileCheckKValuesArgsSchema.safeParse({ ...base, speedUnits: "kph" }).success).toBe(false);
    expect(ProfileCheckKValuesArgsSchema.safeParse({ ...base, speedUnits: "m/s" }).success).toBe(false);
  });

  it("forwards speedUnits to the plugin", async () => {
    sendCommand.mockReset().mockResolvedValue({ allPass: true });
    await PROFILE_DOMAIN_DEFINITION.actions.check_k_values.execute({ ...base, speedUnits: "mph" } as never);
    expect(sendCommand).toHaveBeenCalledWith("profileCheckKValues", {
      alignmentName: "Main St",
      profileName: "FG",
      designSpeed: 50,
      speedUnits: "mph",
    });
  });

  it("exposes speedUnits on the canonical tool and the standalone check_k_values tool", () => {
    for (const exposure of PROFILE_DOMAIN_DEFINITION.exposures) {
      if (exposure.supportedActions.includes("check_k_values")) {
        expect(exposure.inputShape, exposure.toolName).toHaveProperty("speedUnits");
      }
    }
  });
});

describe("civil3d_profile view_create schema", () => {
  const base = { action: "view_create", alignmentName: "Main St", profileViewName: "PV-1", insertX: 0, insertY: 0 };

  beforeEach(() => {
    sendCommand.mockReset().mockResolvedValue({ success: true });
  });

  it("accepts an optional layer", () => {
    expect(ProfileViewCreateArgsSchema.safeParse(base).success).toBe(true);
    expect(ProfileViewCreateArgsSchema.safeParse({ ...base, layer: "C-ROAD-PROF-VIEW" }).success).toBe(true);
    expect(ProfileViewCreateArgsSchema.safeParse({ ...base, layer: 7 }).success).toBe(false);
  });

  it("forwards layer, style and bandSet to the plugin", async () => {
    await PROFILE_DOMAIN_DEFINITION.actions.view_create.execute(
      { ...base, layer: "C-ROAD-PROF-VIEW", style: "Major Grids", bandSet: "EG-FG Elevations" } as never,
    );
    expect(sendCommand).toHaveBeenCalledWith("profileViewCreate", {
      alignmentName: "Main St",
      profileViewName: "PV-1",
      insertX: 0,
      insertY: 0,
      style: "Major Grids",
      bandSet: "EG-FG Elevations",
      layer: "C-ROAD-PROF-VIEW",
    });
  });

  it("maps layer through the standalone civil3d_profile_view_create tool", () => {
    const exposure = PROFILE_DOMAIN_DEFINITION.exposures.find((item) => item.toolName === "civil3d_profile_view_create");
    expect(exposure).toBeDefined();
    expect(exposure!.inputShape).toHaveProperty("layer");
    const resolved = exposure!.resolveAction({ ...base, layer: "C-ROAD-PROF-VIEW" });
    expect(resolved.args).toMatchObject({ action: "view_create", layer: "C-ROAD-PROF-VIEW" });
  });

  it("exposes layer on the canonical civil3d_profile tool", () => {
    const canonical = PROFILE_DOMAIN_DEFINITION.exposures.find((item) => item.toolName === "civil3d_profile");
    expect(canonical).toBeDefined();
    expect(canonical!.inputShape).toHaveProperty("layer");
    expect(canonical!.inputShape).toHaveProperty("speedUnits");
  });
});
