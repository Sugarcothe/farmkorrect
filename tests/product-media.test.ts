import { Collection, MongoServerError, ObjectId } from "mongodb";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { POST as addPhotoRoute } from "@/app/api/products/[id]/images/route";
import { DELETE as removePhotoRoute, PATCH as photoRoute } from "@/app/api/products/[id]/images/[imageId]/route";
import { PATCH as editRoute } from "@/app/api/products/[id]/route";
import { GET as productsRoute, POST as addProductRoute } from "@/app/api/products/route";
import { parseMarketQuery } from "@/lib/market/query";
import { DEFAULT_FULFILLMENT, type Product, type ProductResponse, type ProductsResponse } from "@/lib/orders/types";
import { productFolder } from "@/lib/server/cloudinary";
import { searchMarket } from "@/lib/server/market";
import { collections } from "./support/db";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { outbox } from "./support/outbox";
import { merchant } from "./support/wallet";

// Listing photos. Cloudinary is faked (tests/support/setup.ts): uploads must
// be correctly signed, are kept in outbox.images and can be made to fail.

const CLOUD_URL = /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\/v1\/farm-korret\/products\/[0-9a-f]{32}\.webp$/;
const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 10, description: "" };

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;

async function png(width = 800, height = 600, background = "#2e7d32") {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

async function seller() {
  return merchant("poultry-farmer");
}

async function listProduct(cookie: string) {
  return dataOf(await call<ProductResponse>(addProductRoute, "/api/products", { body: EGGS, cookie })).product;
}

function upload(id: string, bytes: Uint8Array, cookie?: string, contentType = "image/png", options: CallOptions = {}) {
  return call<ProductResponse>(
    (request) => addPhotoRoute(request, { params: Promise.resolve({ id }) }),
    `/api/products/${id}/images`,
    { binaryBody: bytes, cookie, contentType, ...options },
  );
}

function onPhoto(method: "PATCH" | "DELETE", id: string, imageId: string, cookie?: string, body?: unknown) {
  const handler = method === "PATCH" ? photoRoute : removePhotoRoute;
  return call<ProductResponse>(
    (request) => handler(request, { params: Promise.resolve({ id, imageId }) }),
    `/api/products/${id}/images/${imageId}`,
    { method, cookie, body },
  );
}

const storedProduct = async (id: string) =>
  (await (await collections()).products.findOne({ _id: new ObjectId(id) }))!;

/** A seller with a listing that already has `count` photos. */
async function withPhotos(count: number) {
  const s = await seller();
  const product = await listProduct(s.cookie);
  let latest: Product = product;
  const colours = ["#c62828", "#2e7d32", "#1565c0", "#f9a825", "#6a1b9a"];
  for (let i = 0; i < count; i++) {
    const res = await upload(product.id, await png(400, 300, colours[i]), s.cookie);
    expect(res.status).toBe(201);
    latest = dataOf(res).product;
  }
  return { ...s, product: latest };
}

describe("adding listing photos", () => {
  it("re-encodes the photo to a WebP within 1600px, without metadata, and stores only a reference", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie);
    expect(product.images).toEqual([]);

    const original = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#c62828" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "secret-gps-and-camera" } })
      .toBuffer();
    const res = await upload(product.id, original, s.cookie, "image/jpeg");
    expect(res.status).toBe(201);
    const [image] = dataOf(res).product.images;
    expect(image).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), url: expect.stringMatching(CLOUD_URL), width: 1600, height: 800 });
    expect(JSON.stringify(res.json)).not.toContain("publicId");

    // only the cleaned image reached Cloudinary, without being cropped
    expect(outbox.images.size).toBe(1);
    const [[publicId, uploaded]] = [...outbox.images];
    const meta = await sharp(uploaded).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 1600, height: 800 });
    expect(meta.exif).toBeUndefined();
    expect(JSON.stringify(outbox.imageRequests)).not.toContain("test-cloudinary-secret");

    // the listing keeps a reference, never the bytes
    const doc = await storedProduct(product.id);
    expect(doc.images).toEqual([expect.objectContaining({ id: image.id, publicId, url: image.url, width: 1600, height: 800 })]);
    expect(JSON.stringify(doc)).not.toMatch(/data:image|base64|Binary/);
  });

  it("keeps small photos at their size and accepts PNG and WebP", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie);
    const small = await upload(product.id, await png(300, 200), s.cookie, "image/png");
    expect(dataOf(small).product.images[0]).toMatchObject({ width: 300, height: 200 });
    const webp = await sharp(await png(500, 500)).webp().toBuffer();
    const res = await upload(product.id, webp, s.cookie, "image/webp");
    expect(res.status).toBe(201);
    expect(dataOf(res).product.images).toHaveLength(2);
  });

  it("rejects files that aren't the image they claim to be", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    const text = new TextEncoder().encode("<svg onload=alert(1)>");

    expect((await upload(id, text, s.cookie, "image/svg+xml")).status).toBe(415);
    expect((await upload(id, text, s.cookie, "image/gif")).status).toBe(415);
    expect((await upload(id, text, s.cookie, "image/png")).status).toBe(400);
    const jpeg = await sharp(await png()).jpeg().toBuffer();
    expect((await upload(id, jpeg, s.cookie, "image/png")).status).toBe(400);
    const corrupt = Buffer.concat([(await png()).subarray(0, 16), Buffer.alloc(200, 7)]);
    expect((await upload(id, corrupt, s.cookie, "image/png")).status).toBe(400);
    const empty = await upload(id, new Uint8Array(), s.cookie, "image/png");
    expect(empty.status).toBe(400);
    expect(errorOf(empty)).toBe("Choose a photo to upload.");

    expect(outbox.imageRequests).toHaveLength(0);
    expect((await storedProduct(id)).images).toEqual([]);
  });

  it("rejects photos over the size limit", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    const huge = Buffer.concat([await png(), Buffer.alloc(9 * 1024 * 1024)]);
    const res = await upload(id, huge, s.cookie);
    expect(res.status).toBe(413);
    expect(errorOf(res)).toBe("That photo is too large. Choose one under 8 MB.");
    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("rejects photos with too many pixels, even when the file is small", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    const giant = await png(6400, 6400); // 41 megapixels of one colour compress to very little
    expect(giant.length).toBeLessThan(8 * 1024 * 1024);
    const res = await upload(id, giant, s.cookie);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatch(/dimensions are too large/);
    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("allows five photos and refuses a sixth without storing it", async () => {
    const s = await withPhotos(5);
    expect(s.product.images).toHaveLength(5);
    const res = await upload(s.product.id, await png(), s.cookie);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("You can add up to 5 photos. Remove one to add another.");
    expect(outbox.images.size).toBe(5);
    expect((await storedProduct(s.product.id)).images).toHaveLength(5);
  });

  it("never lets uploads at the same time pass the limit; the extra file is deleted again", async () => {
    const s = await withPhotos(4);
    const [a, b] = await Promise.all([
      upload(s.product.id, await png(600, 400, "#000000"), s.cookie),
      upload(s.product.id, await png(600, 400, "#ffffff"), s.cookie),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await storedProduct(s.product.id)).images).toHaveLength(5);
    expect(outbox.images.size).toBe(5);
  });

  it("only lets the listing's own seller add photos", async () => {
    const owner = await withPhotos(0);
    const other = await seller();
    const res = await upload(owner.product.id, await png(), other.cookie);
    expect(res.status).toBe(404);
    expect((await upload("not-an-id", await png(), owner.cookie)).status).toBe(404);
    expect((await upload(new ObjectId().toHexString(), await png(), owner.cookie)).status).toBe(404);

    const vet = await merchant("veterinarian");
    expect((await upload(owner.product.id, await png(), vet.cookie)).status).toBe(403);
    expect((await upload(owner.product.id, await png())).status).toBe(401);
    expect((await upload(owner.product.id, await png(), owner.cookie, "image/png", { origin: "https://evil.example" })).status).toBe(403);

    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("can't add photos to an archived listing", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    await (await collections()).products.updateOne({ _id: new ObjectId(id) }, { $set: { archivedAt: new Date() } });
    expect((await upload(id, await png(), s.cookie)).status).toBe(404);
    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("says uploads are unavailable when Cloudinary isn't configured", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    vi.stubEnv("CLOUDINARY_API_SECRET", "");
    const res = await upload(id, await png(), s.cookie);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("Photo uploads aren't available right now. Please try again later.");
    expect(outbox.imageRequests).toHaveLength(0);
  });

  it("reports a Cloudinary failure honestly and saves nothing", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    outbox.imagesFailing = true;
    const res = await upload(id, await png(), s.cookie);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.json)).not.toMatch(/Server error|cloudinary/i);
    expect((await storedProduct(id)).images).toEqual([]);
  });

  it("deletes the uploaded file again when the listing can't be updated", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    const original = Collection.prototype.findOneAndUpdate;
    const spy = vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(function (
      this: Collection,
      ...args: Parameters<Collection["findOneAndUpdate"]>
    ) {
      if (this.collectionName === "products") throw new MongoServerError({ message: "simulated outage" });
      return original.apply(this, args);
    } as Collection["findOneAndUpdate"]);
    const res = await upload(id, await png(), s.cookie);
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toContain("simulated outage");
    expect(outbox.imageRequests).toHaveLength(2); // upload, then delete
    expect(outbox.images.size).toBe(0);
    expect((await storedProduct(id)).images).toEqual([]);
  });

  it("deletes the uploaded file again when the listing is archived while the photo is processed", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    const original = Collection.prototype.findOneAndUpdate;
    const spy = vi.spyOn(Collection.prototype, "findOneAndUpdate").mockImplementation(async function (
      this: Collection,
      ...args: Parameters<Collection["findOneAndUpdate"]>
    ) {
      if (this.collectionName === "products")
        await this.updateOne({ _id: new ObjectId(id) }, { $set: { archivedAt: new Date() } });
      return original.apply(this, args);
    } as Collection["findOneAndUpdate"]);
    const res = await upload(id, await png(), s.cookie);
    spy.mockRestore();

    expect(res.status).toBe(404);
    expect(outbox.images.size).toBe(0);
    expect((await storedProduct(id)).images).toEqual([]);
  });
});

describe("where listing photos are stored", () => {
  it("keeps them apart from profile photos", () => {
    expect(productFolder("farm-korret/avatars")).toBe("farm-korret/products");
    expect(productFolder("staging/fk/avatars")).toBe("staging/fk/products");
    expect(productFolder("my-app")).toBe("my-app/products");
  });
});

describe("arranging and removing listing photos", () => {
  it("makes a photo the main one, keeping the others in order", async () => {
    const s = await withPhotos(3);
    const [first, second, third] = s.product.images;
    const res = await onPhoto("PATCH", s.product.id, third.id, s.cookie, { primary: true });
    expect(res.status).toBe(200);
    expect(dataOf(res).product.images.map((i) => i.id)).toEqual([third.id, first.id, second.id]);
    expect((await storedProduct(s.product.id)).images!.map((i) => i.id)).toEqual([third.id, first.id, second.id]);
  });

  it("only accepts { primary: true }", async () => {
    const s = await withPhotos(2);
    const [, second] = s.product.images;
    const forged = await onPhoto("PATCH", s.product.id, second.id, s.cookie, { primary: true, url: "https://evil.example/x.png" });
    expect(forged.status).toBe(400);
    expect((forged.json as { fieldErrors?: Record<string, string> }).fieldErrors).toHaveProperty("url");
    expect((await onPhoto("PATCH", s.product.id, second.id, s.cookie, { primary: false })).status).toBe(400);
    expect((await onPhoto("PATCH", s.product.id, second.id, s.cookie, {})).status).toBe(400);
    expect((await storedProduct(s.product.id)).images!.map((i) => i.id)).toEqual(s.product.images.map((i) => i.id));
  });

  it("removes a photo from the listing and then from Cloudinary", async () => {
    const s = await withPhotos(2);
    const [first, second] = s.product.images;
    const publicId = (await storedProduct(s.product.id)).images![0].publicId;
    expect(outbox.images.has(publicId)).toBe(true);

    const res = await onPhoto("DELETE", s.product.id, first.id, s.cookie);
    expect(res.status).toBe(200);
    expect(dataOf(res).product.images.map((i) => i.id)).toEqual([second.id]);
    expect(outbox.images.has(publicId)).toBe(false);
    expect(outbox.images.size).toBe(1);
    expect((await storedProduct(s.product.id)).images!.map((i) => i.id)).toEqual([second.id]);

    const again = await onPhoto("DELETE", s.product.id, first.id, s.cookie);
    expect(again.status).toBe(404);
    expect(errorOf(again)).toMatch(/couldn't find that photo/);
    expect((await onPhoto("DELETE", s.product.id, "../../etc", s.cookie)).status).toBe(404);
  });

  it("keeps the listing consistent when Cloudinary can't delete the file", async () => {
    const s = await withPhotos(1);
    outbox.imagesFailing = true;
    const res = await onPhoto("DELETE", s.product.id, s.product.images[0].id, s.cookie);
    // the listing no longer refers to the file either way; a leftover file is harmless
    expect((await storedProduct(s.product.id)).images).toEqual([]);
    expect([200, 502]).toContain(res.status);
  });

  it("doesn't let another seller arrange or remove photos", async () => {
    const owner = await withPhotos(2);
    const other = await seller();
    const [, second] = owner.product.images;
    expect((await onPhoto("PATCH", owner.product.id, second.id, other.cookie, { primary: true })).status).toBe(404);
    expect((await onPhoto("DELETE", owner.product.id, second.id, other.cookie)).status).toBe(404);
    expect((await onPhoto("DELETE", owner.product.id, second.id)).status).toBe(401);
    const vet = await merchant("veterinarian");
    expect((await onPhoto("DELETE", owner.product.id, second.id, vet.cookie)).status).toBe(403);

    expect(outbox.images.size).toBe(2);
    expect((await storedProduct(owner.product.id)).images!.map((i) => i.id)).toEqual(owner.product.images.map((i) => i.id));
  });

  it("can't be changed through the listing's own edit route", async () => {
    const s = await withPhotos(1);
    const res = await call(
      (request) => editRoute(request, { params: Promise.resolve({ id: s.product.id }) }),
      `/api/products/${s.product.id}`,
      { method: "PATCH", cookie: s.cookie, body: { images: [] } },
    );
    expect(res.status).toBe(400);
    expect((await storedProduct(s.product.id)).images).toHaveLength(1);
  });
});

describe("photos in the Market", () => {
  it("shows only the main photo in search results", async () => {
    const s = await withPhotos(3);
    const viewer = await merchant("veterinarian");
    const [found] = (await searchMarket(new ObjectId(viewer.userId), parseMarketQuery({}))).products.filter(
      (p) => p.id === s.product.id,
    );
    expect(found.images).toEqual([s.product.images[0]]);
    expect(JSON.stringify(found)).not.toContain("publicId");
  });

  it("treats listings from before photos and delivery options as having neither", async () => {
    const s = await seller();
    const { id } = await listProduct(s.cookie);
    await (await collections()).products.updateOne({ _id: new ObjectId(id) }, { $unset: { images: "", fulfillment: "" } });

    const [listed] = dataOf(await call<ProductsResponse>(productsRoute, "/api/products", { cookie: s.cookie })).products;
    expect(listed).toMatchObject({ id, images: [], fulfillment: DEFAULT_FULFILLMENT });

    const viewer = await merchant("veterinarian");
    const [found] = (await searchMarket(new ObjectId(viewer.userId), parseMarketQuery({}))).products.filter((p) => p.id === id);
    expect(found).toMatchObject({ images: [], fulfillment: DEFAULT_FULFILLMENT });

    // and a first photo can still be added
    const res = await upload(id, await png(), s.cookie);
    expect(res.status).toBe(201);
    expect(dataOf(res).product.images).toHaveLength(1);
  });
});
