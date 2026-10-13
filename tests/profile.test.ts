import { Collection, MongoServerError } from "mongodb";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { GET as getProfile, PATCH as patchProfile } from "@/app/api/profile/route";
import { DELETE as deletePhoto, POST as uploadPhoto } from "@/app/api/profile/photo/route";
import type { ProfilePhotoResponse, ProfileResponse } from "@/lib/profile/types";
import { collections, userByPhone } from "./support/db";
import { FARM, newRegistration, registerPending, registerVerified, registerWithFarm } from "./support/flows";
import { call, dataOf, type CallOptions } from "./support/http";
import { outbox } from "./support/outbox";

const read = (cookie?: string) => call<ProfileResponse>(getProfile, "/api/profile", { cookie });

const patch = (body: unknown, cookie?: string, options: CallOptions = {}) =>
  call<ProfileResponse>(patchProfile, "/api/profile", { method: "PATCH", body, cookie, ...options });

const vet = () => registerWithFarm(newRegistration({ role: "veterinarian", fullName: "Tunde Bakare" }));
const specialist = () => registerWithFarm(newRegistration({ role: "non-vet-specialist" }));

function fieldErrorsOf(result: { json: { ok: boolean } }) {
  const json = result.json as { ok: false; fieldErrors?: Record<string, string> };
  return json.fieldErrors ?? {};
}

async function png(width = 800, height = 600) {
  return sharp({ create: { width, height, channels: 3, background: "#2e7d32" } }).png().toBuffer();
}

const upload = (bytes: Uint8Array, cookie?: string, contentType = "image/png", origin?: string | null) =>
  call<ProfilePhotoResponse>(uploadPhoto, "/api/profile/photo", { binaryBody: bytes, cookie, contentType, origin });

describe("GET /api/profile", () => {
  it("requires a signed-in, verified account", async () => {
    expect((await read()).status).toBe(401);
    expect((await read("not-a-real-session-token")).status).toBe(401);

    const { pendingCookie } = await registerPending();
    expect((await read(pendingCookie)).status).toBe(403);
  });

  it("returns the farmer's profile with their farm, and nothing sensitive", async () => {
    const { input, cookie } = await registerWithFarm();
    const res = await read(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const { profile } = dataOf(res);
    expect(profile).toEqual({
      role: "poultry-farmer",
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      photoUrl: null,
      bio: "",
      location: FARM.location,
      yearsOfExperience: FARM.yearsOfExperience,
      farm: { farmName: FARM.farmName, farmType: FARM.farmType, birdCount: FARM.birdCount },
      specialization: "",
      qualifications: "",
      registrationNumber: "",
      credentialStatus: "not_submitted",
    });
    const raw = JSON.stringify(res.json);
    expect(raw).not.toMatch(/passwordHash|tokenHash|_id|argon2/);
  });

  it("initialises a professional who has never edited their profile", async () => {
    const { input, cookie } = await vet();
    expect((await userByPhone(input.phone))!.profile).toBeUndefined();

    const { profile } = dataOf(await read(cookie));
    expect(profile).toMatchObject({
      role: "veterinarian",
      farm: null,
      bio: "",
      specialization: "",
      location: FARM.location,
      yearsOfExperience: FARM.yearsOfExperience,
      credentialStatus: "not_submitted",
    });
  });

  it("handles a farmer who skipped farm setup", async () => {
    const { cookie } = await registerVerified();
    const { profile } = dataOf(await read(cookie));
    expect(profile.farm).toBeNull();
    expect(profile.location).toBe("");
    expect(profile.yearsOfExperience).toBeNull();
  });
});

describe("PATCH /api/profile", () => {
  it("updates a farmer's details and farm, and the next read reflects them", async () => {
    const { input, cookie } = await registerWithFarm();
    const res = await patch(
      {
        fullName: "  Adaeze   Okafor-Bello ",
        bio: "Layer farmer.\r\n\r\n\r\n\r\nSupplying eggs   in Ibadan.",
        farmName: "Bello Farms",
        location: "Ogbomoso, Oyo State",
        farmType: "layer",
        birdCount: 12000,
        yearsOfExperience: 8,
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const expected = {
      fullName: "Adaeze Okafor-Bello",
      bio: "Layer farmer.\n\nSupplying eggs in Ibadan.",
      location: "Ogbomoso, Oyo State",
      yearsOfExperience: 8,
      farm: { farmName: "Bello Farms", farmType: "layer", birdCount: 12000 },
    };
    expect(dataOf(res).profile).toMatchObject(expected);
    expect(dataOf(await read(cookie)).profile).toMatchObject(expected);

    const { farms } = await collections();
    expect(await farms.countDocuments()).toBe(1);
    const user = await userByPhone(input.phone);
    expect(user!.fullName).toBe("Adaeze Okafor-Bello");
    expect(user!.role).toBe("poultry-farmer");
  });

  it("changes only the fields that were sent", async () => {
    const { cookie } = await registerWithFarm();
    dataOf(await patch({ bio: "First bio" }, cookie));
    const { profile } = dataOf(await patch({ birdCount: 6000 }, cookie));
    expect(profile.bio).toBe("First bio");
    expect(profile.farm).toEqual({ farmName: FARM.farmName, farmType: FARM.farmType, birdCount: 6000 });
  });

  it("updates a veterinarian's professional details", async () => {
    const { cookie } = await vet();
    const { profile } = dataOf(
      await patch(
        {
          specialization: "avian-pathology",
          yearsOfExperience: 12,
          location: "Abeokuta, Ogun State",
          qualifications: "DVM, University of Ibadan",
        },
        cookie,
      ),
    );
    expect(profile).toMatchObject({
      specialization: "avian-pathology",
      yearsOfExperience: 12,
      location: "Abeokuta, Ogun State",
      qualifications: "DVM, University of Ibadan",
    });
    // the farm record isn't touched for professionals
    const farm = await (await collections()).farms.findOne({});
    expect(farm!.location).toBe(FARM.location);
  });

  it("marks a submitted registration number as pending, never verified", async () => {
    const { input, cookie } = await vet();
    const { profile } = dataOf(await patch({ registrationNumber: " vcn/12345 " }, cookie));
    expect(profile.registrationNumber).toBe("VCN/12345");
    expect(profile.credentialStatus).toBe("pending");
    const stored = (await userByPhone(input.phone))!.profile!;
    expect(stored.credentialStatus).toBe("pending");
    expect(stored.credentialSubmittedAt).toBeInstanceOf(Date);

    const cleared = dataOf(await patch({ registrationNumber: "" }, cookie)).profile;
    expect(cleared.registrationNumber).toBe("");
    expect(cleared.credentialStatus).toBe("not_submitted");
  });

  it("won't change a registration number that has been verified", async () => {
    const { input, cookie } = await vet();
    dataOf(await patch({ registrationNumber: "VCN/12345" }, cookie));
    // only a reviewer can do this, directly in the database
    await (await collections()).users.updateOne(
      { phoneNormalized: input.phone },
      { $set: { "profile.credentialStatus": "verified" } },
    );

    const res = await patch({ registrationNumber: "VCN/99999" }, cookie);
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res)).toHaveProperty("registrationNumber");

    // resubmitting the same number with other edits keeps it verified
    const ok = dataOf(await patch({ registrationNumber: "VCN/12345", bio: "Hello" }, cookie));
    expect(ok.profile.credentialStatus).toBe("verified");
    expect(ok.profile.registrationNumber).toBe("VCN/12345");
  });

  it("requires a signed-in, verified account and a same-origin request", async () => {
    expect((await patch({ bio: "x" })).status).toBe(401);

    const { pendingCookie } = await registerPending();
    expect((await patch({ bio: "x" }, pendingCookie)).status).toBe(403);

    const { cookie } = await registerWithFarm();
    expect((await patch({ bio: "x" }, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await patch({ bio: "x" }, cookie, { origin: null })).status).toBe(403);
    expect((await patch(undefined, cookie, { rawBody: "bio=x", contentType: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect(dataOf(await read(cookie)).profile.bio).toBe("");
  });

  it("validates input and stores nothing when any field is invalid", async () => {
    const { input, cookie } = await vet();
    const before = await userByPhone(input.phone);

    const res = await patch(
      {
        fullName: "",
        bio: "x".repeat(501),
        location: "   ",
        yearsOfExperience: 100,
        specialization: "witchcraft",
        qualifications: "q".repeat(201),
        registrationNumber: "<script>",
      },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(res)).sort()).toEqual([
      "bio",
      "fullName",
      "location",
      "qualifications",
      "registrationNumber",
      "specialization",
      "yearsOfExperience",
    ]);

    const types = await patch({ yearsOfExperience: "5", fullName: 42 }, cookie);
    expect(types.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(types)).sort()).toEqual(["fullName", "yearsOfExperience"]);
    expect((await patch({ yearsOfExperience: 2.5 }, cookie)).status).toBe(400);

    expect((await patch({}, cookie)).status).toBe(400);
    expect((await patch([], cookie)).status).toBe(400);

    const after = await userByPhone(input.phone);
    expect(after).toEqual(before);
  });

  it("only accepts the fields that belong to the account's role", async () => {
    const farmer = await registerWithFarm();
    const asFarmer = await patch({ specialization: "poultry-medicine", registrationNumber: "VCN/1" }, farmer.cookie);
    expect(asFarmer.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(asFarmer)).sort()).toEqual(["registrationNumber", "specialization"]);

    const doctor = await vet();
    expect((await patch({ farmName: "Not mine", birdCount: 10 }, doctor.cookie)).status).toBe(400);
    // a specialist's category isn't a valid veterinary specialization
    expect((await patch({ specialization: "poultry-nutrition" }, doctor.cookie)).status).toBe(400);

    const consultant = await specialist();
    const asSpecialist = await patch({ registrationNumber: "VCN/12345" }, consultant.cookie);
    expect(asSpecialist.status).toBe(400);
    expect(dataOf(await patch({ specialization: "poultry-nutrition" }, consultant.cookie)).profile.specialization).toBe(
      "poultry-nutrition",
    );
  });

  it("refuses protected account fields, even alongside valid ones", async () => {
    const { input, cookie } = await registerWithFarm();
    const before = await userByPhone(input.phone);

    for (const [key, value] of Object.entries({
      role: "veterinarian",
      email: "new@example.com",
      phone: "+2348039999999",
      emailNormalized: "new@example.com",
      phoneNormalized: "+2348039999999",
      status: "active",
      phoneVerifiedAt: "2020-01-01",
      emailVerifiedAt: "2020-01-01",
      passwordHash: "x",
      password: "NewPassw0rd",
      credentialStatus: "verified",
      "profile.credentialStatus": "verified",
      profile: { credentialStatus: "verified" },
      isVerified: true,
      sessionToken: "abc",
      _id: "000000000000000000000000",
    })) {
      const res = await patch({ fullName: "Changed Name", [key]: value }, cookie);
      expect(res.status, key).toBe(400);
      expect(fieldErrorsOf(res), key).toHaveProperty([key]);
    }

    const proto = await patch(undefined, cookie, { rawBody: '{"__proto__":{"role":"veterinarian"}}' });
    expect(proto.status).toBe(400);

    expect(await userByPhone(input.phone)).toEqual(before);
  });

  it("only ever edits the signed-in account, whatever id the client sends", async () => {
    const victim = await registerWithFarm();
    const attacker = await registerWithFarm(newRegistration({ fullName: "Mallory Eze" }));
    const victimUser = await userByPhone(victim.input.phone);
    const victimFarm = await (await collections()).farms.findOne({ ownerUserId: victimUser!._id });

    for (const key of ["userId", "ownerUserId", "id"]) {
      const res = await patch({ [key]: victimUser!._id.toHexString(), bio: "pwned" }, attacker.cookie);
      expect(res.status).toBe(400);
    }
    const own = await patch({ bio: "My own bio", farmName: "Mallory Farms" }, attacker.cookie);
    expect(dataOf(own).profile.fullName).toBe("Mallory Eze");

    expect(await userByPhone(victim.input.phone)).toEqual(victimUser);
    expect(await (await collections()).farms.findOne({ ownerUserId: victimUser!._id })).toEqual(victimFarm);
    expect(dataOf(await read(victim.cookie)).profile.bio).toBe("");
  });

  it("creates the farm when a farmer without one sends every farm detail", async () => {
    const { cookie } = await registerVerified();
    const partial = await patch({ farmName: "New Farm" }, cookie);
    expect(partial.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(partial)).sort()).toEqual(["birdCount", "farmType", "location", "yearsOfExperience"]);
    expect(await (await collections()).farms.countDocuments()).toBe(0);

    const full = await patch({ ...FARM }, cookie);
    expect(dataOf(full).profile.farm).toEqual({
      farmName: FARM.farmName,
      farmType: FARM.farmType,
      birdCount: FARM.birdCount,
    });
    expect(await (await collections()).farms.countDocuments()).toBe(1);
  });

  it("reports a database failure generically and leaves the profile unchanged", async () => {
    const { input, cookie } = await registerWithFarm();
    const before = await userByPhone(input.phone);
    const farmBefore = await (await collections()).farms.findOne({});

    const spy = vi
      .spyOn(Collection.prototype, "updateOne")
      .mockRejectedValue(new MongoServerError({ message: "E11000 internal detail users.passwordHash", code: 8000 }));
    try {
      const res = await patch({ fullName: "New Name", birdCount: 9999 }, cookie);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.json)).not.toMatch(/E11000|passwordHash|internal detail/);
      expect(res.json).toEqual({ ok: false, error: "Something went wrong on our side. Please try again." });
    } finally {
      spy.mockRestore();
    }

    expect(await userByPhone(input.phone)).toEqual(before);
    expect(await (await collections()).farms.findOne({})).toEqual(farmBefore);
  });
});

describe("profile photo", () => {
  const CLOUD_URL = /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\/v1\/farm-korret\/avatars\/[0-9a-f]{32}\.webp$/;

  it("re-encodes an upload to a small WebP without metadata before it goes to Cloudinary", async () => {
    const { input, cookie } = await registerWithFarm();
    const original = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#c62828" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "secret-gps-and-camera" } })
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const res = await upload(original, cookie, "image/jpeg");
    expect(res.status).toBe(200);
    expect(dataOf(res).photoUrl).toMatch(CLOUD_URL);
    expect(dataOf(await read(cookie)).profile.photoUrl).toBe(dataOf(res).photoUrl);

    // only the cleaned image was uploaded
    expect(outbox.images.size).toBe(1);
    const [[publicId, uploaded]] = [...outbox.images];
    const meta = await sharp(uploaded).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 512, height: 512 });
    expect(meta.exif).toBeUndefined();

    // the request was signed; the secret itself was never sent
    expect(JSON.stringify(outbox.imageRequests)).not.toContain("test-cloudinary-secret");
    expect(outbox.imageRequests[0]).toMatchObject({ public_id: publicId, overwrite: "false" });

    // the user document only references the file
    const user = await userByPhone(input.phone);
    expect(user!.profile!.photo).toMatchObject({ publicId, url: dataOf(res).photoUrl, width: 512, height: 512 });
    expect(JSON.stringify(user)).not.toMatch(/data:image|base64|Binary/);
  });

  it("replaces the previous photo, deleting the old file, and can remove it", async () => {
    const { input, cookie } = await registerWithFarm();
    const first = dataOf(await upload(await png(), cookie)).photoUrl;
    const second = dataOf(await upload(await png(300, 900), cookie)).photoUrl;
    expect(second).not.toBe(first);
    expect(outbox.images.size).toBe(1);
    expect(dataOf(await read(cookie)).profile.photoUrl).toBe(second);

    const removed = await call(deletePhoto, "/api/profile/photo", { method: "DELETE", cookie });
    expect(removed.status).toBe(200);
    expect(outbox.images.size).toBe(0);
    expect((await userByPhone(input.phone))!.profile?.photo).toBeUndefined();
    expect(dataOf(await read(cookie)).profile.photoUrl).toBeNull();
  });

  it("rejects files that aren't the image they claim to be", async () => {
    const { cookie } = await registerWithFarm();
    const text = new TextEncoder().encode("<svg onload=alert(1)>");

    expect((await upload(text, cookie, "image/svg+xml")).status).toBe(415);
    expect((await upload(text, cookie, "text/plain")).status).toBe(415);
    expect((await upload(text, cookie, "image/png")).status).toBe(400);
    // real JPEG bytes labelled as PNG
    const jpeg = await sharp(await png()).jpeg().toBuffer();
    expect((await upload(jpeg, cookie, "image/png")).status).toBe(400);
    // a PNG signature followed by garbage
    const corrupt = Buffer.concat([(await png()).subarray(0, 16), Buffer.alloc(200, 7)]);
    expect((await upload(corrupt, cookie, "image/png")).status).toBe(400);
    expect((await upload(new Uint8Array(), cookie, "image/png")).status).toBe(400);

    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("rejects photos over the size limit", async () => {
    const { cookie } = await registerWithFarm();
    const huge = Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(huge, cookie);
    expect(res.status).toBe(413);
    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("requires a signed-in, verified account and a same-origin request", async () => {
    const image = await png();
    expect((await upload(image)).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await upload(image, pendingCookie)).status).toBe(403);
    const { cookie } = await registerWithFarm();
    expect((await upload(image, cookie, "image/png", "https://evil.example")).status).toBe(403);
    expect((await call(deletePhoto, "/api/profile/photo", { method: "DELETE" })).status).toBe(401);
    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("reports a Cloudinary failure honestly and keeps the current photo", async () => {
    const { input, cookie } = await registerWithFarm();
    const current = dataOf(await upload(await png(), cookie)).photoUrl;

    outbox.imagesFailing = true;
    const res = await upload(await png(300, 300), cookie);
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ ok: false, error: "We couldn't save your photo right now. Please try again." });
    expect(JSON.stringify(res.json)).not.toMatch(/Server error|cloudinary/i);
    expect((await userByPhone(input.phone))!.profile!.photo!.url).toBe(current);
  });

  it("removes the uploaded file again when the profile can't be updated", async () => {
    const { input, cookie } = await registerWithFarm();
    const original = Collection.prototype.findOneAndUpdate;
    // fail only the profile write (the rate limiter uses this method too)
    const spy = vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(function (
      this: Collection,
      ...args: Parameters<Collection["findOneAndUpdate"]>
    ) {
      if (this.collectionName === "users") throw new MongoServerError({ message: "simulated outage" });
      return original.apply(this, args);
    } as Collection["findOneAndUpdate"]);
    const res = await upload(await png(), cookie);
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toContain("simulated outage");
    expect(outbox.imageRequests.map((r) => r.public_id)).toHaveLength(2); // upload, then delete
    expect(outbox.images.size).toBe(0);
    expect((await userByPhone(input.phone))!.profile?.photo).toBeUndefined();
  });

  it("says uploads are unavailable when Cloudinary isn't configured", async () => {
    const { cookie } = await registerWithFarm();
    vi.stubEnv("CLOUDINARY_API_SECRET", "");
    const res = await upload(await png(), cookie);
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ ok: false, error: "Photo uploads aren't available right now. Please try again later." });
    expect(outbox.imageRequests).toHaveLength(0);
  });
});
