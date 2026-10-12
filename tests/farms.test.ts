import { describe, expect, it } from "vitest";
import { POST as saveFarm } from "@/app/api/farms/route";
import { GET as session } from "@/app/api/auth/session/route";
import type { FarmResponse, SessionResponse } from "@/lib/auth/types";
import { collections, userByPhone } from "./support/db";
import { FARM, registerVerified } from "./support/flows";
import { call, dataOf } from "./support/http";

describe("POST /api/farms", () => {
  it("saves the farm for the signed-in account", async () => {
    const { input, cookie } = await registerVerified();
    const res = await call<FarmResponse>(saveFarm, "/api/farms", { body: FARM, cookie });
    expect(res.status).toBe(201);
    expect(dataOf(res).farm).toMatchObject(FARM);
    expect(dataOf(res).farm.id).toMatch(/^[0-9a-f]{24}$/);

    const user = await userByPhone(input.phone);
    const stored = await (await collections()).farms.findOne({});
    expect(stored!.ownerUserId.equals(user!._id)).toBe(true);

    const me = await call<SessionResponse>(session, "/api/auth/session", { cookie });
    expect(dataOf(me).farmSetupComplete).toBe(true);
  });

  it("requires a session", async () => {
    const res = await call(saveFarm, "/api/farms", { body: FARM });
    expect(res.status).toBe(401);
    expect(await (await collections()).farms.countDocuments()).toBe(0);
  });

  it("ignores owner ids, roles and verification flags sent by the client", async () => {
    const victim = await registerVerified();
    const attacker = await registerVerified();
    const victimUser = await userByPhone(victim.input.phone);

    const res = await call<FarmResponse>(saveFarm, "/api/farms", {
      body: {
        ...FARM,
        ownerUserId: victimUser!._id.toHexString(),
        userId: victimUser!._id.toHexString(),
        role: "veterinarian",
        isVerified: true,
        initialProfile: false,
        _id: "000000000000000000000000",
      },
      cookie: attacker.cookie,
    });
    expect(res.status).toBe(201);

    const attackerUser = await userByPhone(attacker.input.phone);
    const { farms } = await collections();
    const stored = await farms.findOne({});
    expect(stored!.ownerUserId.equals(attackerUser!._id)).toBe(true);
    expect(stored!._id.toHexString()).not.toBe("000000000000000000000000");
    expect(stored).not.toHaveProperty("role");
    expect(stored).not.toHaveProperty("isVerified");
    expect(stored!.initialProfile).toBe(true);
    expect(await farms.countDocuments({ ownerUserId: victimUser!._id })).toBe(0);
    expect((await userByPhone(attacker.input.phone))!.role).toBe("poultry-farmer");
  });

  it("updates the same profile when submitted again, including concurrently", async () => {
    const { cookie } = await registerVerified();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => call<FarmResponse>(saveFarm, "/api/farms", { body: FARM, cookie })),
    );
    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);

    const again = await call<FarmResponse>(saveFarm, "/api/farms", {
      body: { ...FARM, birdCount: 7500 },
      cookie,
    });
    expect(again.status).toBe(200);
    expect(dataOf(again).farm.id).toBe(dataOf(results[0]).farm.id);
    expect(dataOf(again).farm.birdCount).toBe(7500);
    expect(await (await collections()).farms.countDocuments()).toBe(1);
  });

  it("validates every field", async () => {
    const { cookie } = await registerVerified();
    const res = await call(saveFarm, "/api/farms", {
      body: { farmName: "", location: "x".repeat(200), farmType: "ducks", birdCount: 2.5, yearsOfExperience: -1 },
      cookie,
    });
    expect(res.status).toBe(400);
    if (res.json.ok) throw new Error("expected failure");
    expect(Object.keys(res.json.fieldErrors ?? {}).sort()).toEqual(
      ["birdCount", "farmName", "farmType", "location", "yearsOfExperience"],
    );
    const strings = await call(saveFarm, "/api/farms", { body: { ...FARM, birdCount: "5000" }, cookie });
    expect(strings.status).toBe(400);
  });
});
