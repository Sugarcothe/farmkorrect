import { randomUUID } from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { POST as placeRoute } from "@/app/api/orders/route";
import { POST as postReviewRoute } from "@/app/api/products/[id]/reviews/route";
import { PATCH as editRoute } from "@/app/api/products/[id]/route";
import { POST as addProductRoute } from "@/app/api/products/route";
import { DELETE as withdrawRoute } from "@/app/api/reviews/[id]/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import { isNigerianState, NIGERIAN_STATES, parseNigerianState } from "@/lib/locations/nigeria";
import {
  activeFilters,
  cleanSearchText,
  DEFAULT_MARKET_QUERY,
  MARKET_LIMITS,
  marketHref,
  parseMarketQuery,
  withChanges,
  type MarketQuery,
} from "@/lib/market/query";
import type { CheckoutResponse, OrderResponse, ProductResponse, VerifyPaymentResponse } from "@/lib/orders/types";
import type { ReviewResponse } from "@/lib/reviews/types";
import { rebuildCatalogSearch, refreshProductRating, searchTermsFor } from "@/lib/server/catalog";
import { getDb } from "@/lib/server/db";
import { searchMarket, trySearchMarket } from "@/lib/server/market";
import type { ProductDoc, ReviewDoc } from "@/lib/server/models";
import { collections } from "./support/db";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { completeCheckout } from "./support/paystack";
import { merchant } from "./support/wallet";

// The Market search runs against the in-memory MongoDB with the real
// indexes (tests/support/setup.ts), so text matching, stemming and index-
// backed sorts behave as they do in production. Most listings are written
// straight into the database to keep the tests quick; the product API,
// reviews and orders are exercised through their routes where it matters.

type Ctx = { params: Promise<{ id: string }> };
type RouteWithId = (request: Request, context: Ctx) => Promise<Response>;

function callId<T>(handler: RouteWithId, path: string, id: string, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve({ id }) }), path, options);
}

const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

const viewer = new ObjectId();
const sellerId = new ObjectId();
let clock = Date.UTC(2026, 0, 1);

/** A listing written straight into the database, each one newer than the last. */
async function insertProduct(fields: Partial<ProductDoc> = {}): Promise<ProductDoc> {
  clock += 60_000;
  const category = fields.category ?? "eggs";
  const doc: ProductDoc = {
    _id: new ObjectId(),
    sellerUserId: sellerId,
    name: "Fresh eggs",
    category,
    description: "",
    unit: "crate",
    priceKobo: 4_500_00,
    stockQuantity: 10,
    active: true,
    archivedAt: null,
    state: null,
    area: "",
    searchTerms: searchTermsFor(category),
    ratingCount: 0,
    ratingAverage: null,
    createdAt: new Date(clock),
    updatedAt: new Date(clock),
    ...fields,
  };
  await (await collections()).products.insertOne(doc);
  return doc;
}

async function insertReview(product: ProductDoc, rating: number, status: ReviewDoc["status"] = "published") {
  const now = new Date();
  await (await collections()).reviews.insertOne({
    _id: new ObjectId(),
    productId: product._id,
    sellerUserId: product.sellerUserId,
    reviewerUserId: new ObjectId(),
    orderId: new ObjectId(),
    orderItemIndex: 0,
    rating,
    text: "Inserted for this test.",
    status,
    verifiedPurchase: true,
    editedAt: null,
    withdrawnAt: status === "withdrawn" ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

const search = (params: Record<string, string> = {}) => searchMarket(viewer, parseMarketQuery(params));
const names = async (params: Record<string, string> = {}) => (await search(params)).products.map((p) => p.name);
const query = (changes: Partial<MarketQuery> = {}): MarketQuery => ({ ...DEFAULT_MARKET_QUERY, ...changes });

// --- the address ---------------------------------------------------------------------------

describe("market query parsing", () => {
  it("defaults to the whole Market, recommended, page 1", () => {
    expect(parseMarketQuery({})).toEqual(DEFAULT_MARKET_QUERY);
    expect(marketHref(parseMarketQuery({}))).toBe("/market");
  });

  it("ignores values it doesn't recognise rather than trusting them", () => {
    expect(
      parseMarketQuery({
        category: "ostriches",
        state: "atlantis",
        minPrice: "-5",
        maxPrice: "1e9",
        minRating: "9",
        stock: "yes",
        sort: "popular",
        page: "0",
        sellerUserId: viewer.toHexString(),
      }),
    ).toEqual(DEFAULT_MARKET_QUERY);
    expect(parseMarketQuery({ page: "1000000" }).page).toBe(1);
    expect(parseMarketQuery({ page: "2.5" }).page).toBe(1);
    expect(parseMarketQuery({ minRating: "3.5" }).minRating).toBeNull();
  });

  it("reads naira prices, swapping a minimum above the maximum", () => {
    expect(parseMarketQuery({ minPrice: "10,000", maxPrice: "2000" })).toMatchObject({
      minPriceKobo: 2_000_00,
      maxPriceKobo: 10_000_00,
    });
  });

  it("drops the preferred state when results are limited to one state", () => {
    expect(parseMarketQuery({ state: "lagos", near: "oyo" })).toMatchObject({ state: "lagos", near: null });
    expect(parseMarketQuery({ near: "oyo" })).toMatchObject({ state: null, near: "oyo" });
  });

  it("accepts a state's name in any case, but never guesses from part of one", () => {
    expect(parseMarketQuery({ state: "Akwa Ibom" }).state).toBe("akwa-ibom");
    expect(parseMarketQuery({ state: "ABUJA" }).state).toBe("fct");
    expect(parseNigerianState("Lag")).toBeNull();
    expect(parseNigerianState("Lagos State, Ikeja")).toBeNull();
    expect(NIGERIAN_STATES).toHaveLength(37);
    expect(NIGERIAN_STATES.every((s) => isNigerianState(s.value))).toBe(true);
  });

  it("keeps search text to letters and numbers, within the length limits", () => {
    expect(cleanSearchText('  "fresh"   -eggs!! ')).toBe("fresh eggs");
    expect(cleanSearchText("$where: 1")).toBe("where 1");
    expect(cleanSearchText("   ")).toBeNull();
    expect(cleanSearchText(["eggs"])).toBeNull();
    expect(cleanSearchText("a b c d e f g h i j")!.split(" ")).toHaveLength(MARKET_LIMITS.query.words);
    expect(cleanSearchText("x".repeat(500))).toBeNull(); // one word longer than allowed
    expect(cleanSearchText("eggs " + "x".repeat(200))).toBe("eggs");
  });

  it("round-trips through the canonical address", () => {
    const q = parseMarketQuery({
      q: "layer eggs",
      category: "eggs",
      near: "oyo",
      minPrice: "1000",
      maxPrice: "9000",
      minRating: "4",
      stock: "all",
      sort: "price_asc",
      page: "3",
    });
    const href = marketHref(q);
    expect(href).toBe(
      "/market?q=layer+eggs&category=eggs&near=oyo&minPrice=1000&maxPrice=9000&minRating=4&stock=all&sort=price_asc&page=3",
    );
    expect(parseMarketQuery(new URL(href, "http://x").searchParams)).toEqual(q);
  });

  it("goes back to page 1 when anything but the page changes", () => {
    const q = query({ page: 4, category: "eggs" });
    expect(withChanges(q, { sort: "newest" }).page).toBe(1);
    expect(withChanges(q, { page: 5 }).page).toBe(5);
  });

  it("lists each active filter with what removes it", () => {
    const q = query({ q: "eggs", state: "lagos", minPriceKobo: 1_000_00, minRating: 4, includeSoldOut: true });
    const filters = activeFilters(q);
    expect(filters.map((f) => f.key)).toEqual(["q", "state", "price", "minRating", "stock"]);
    const withoutState = withChanges(q, filters.find((f) => f.key === "state")!.clear);
    expect(withoutState).toMatchObject({ state: null, q: "eggs", minRating: 4 });
  });
});

// --- keywords --------------------------------------------------------------------------------

describe("keyword search", () => {
  it("matches names, descriptions and the category's everyday words, ignoring case and plurals", async () => {
    await insertProduct({ name: "Jumbo Crate", description: "Brown shells, collected daily" });
    await insertProduct({ name: "Broiler birds", category: "live-birds" });
    await insertProduct({ name: "Organic fertiliser", category: "manure", description: "Dried droppings" });

    expect(await names({ q: "jumbo" })).toEqual(["Jumbo Crate"]);
    expect(await names({ q: "SHELL" })).toEqual(["Jumbo Crate"]);
    expect(await names({ q: "egg" })).toEqual(["Jumbo Crate"]); // eggs category's own words
    expect(await names({ q: "chickens" })).toEqual(["Broiler birds"]);
    expect(await names({ q: "dropping" })).toEqual(["Organic fertiliser"]);
    expect(await names({ q: "quail" })).toEqual([]);
    expect(await names({ q: "!!!" })).toHaveLength(3); // nothing searchable left: the whole Market
  });

  it("puts name matches ahead of description and category matches", async () => {
    await insertProduct({ name: "Farm basket", description: "Includes turkey" });
    await insertProduct({ name: "Live turkey", category: "live-birds" });
    expect(await names({ q: "turkey" })).toEqual(["Live turkey", "Farm basket"]);
  });

  it("shows only listed, in-stock products", async () => {
    await insertProduct({ name: "Listed eggs" });
    await insertProduct({ name: "Hidden eggs", active: false });
    await insertProduct({ name: "Removed eggs", archivedAt: new Date() });
    await insertProduct({ name: "Sold out eggs", stockQuantity: 0 });
    expect(await names({ q: "eggs" })).toEqual(["Listed eggs"]);
    expect((await names({ q: "eggs", stock: "all" })).sort()).toEqual(["Listed eggs", "Sold out eggs"]);
    expect(await names({ stock: "all" })).not.toContain("Hidden eggs");
    expect(await names({ stock: "all" })).not.toContain("Removed eggs");
  });
});

// --- filters --------------------------------------------------------------------------------

describe("filters", () => {
  it("filters by category, price and state together", async () => {
    await insertProduct({ name: "Cheap Lagos eggs", priceKobo: 2_000_00, state: "lagos" });
    await insertProduct({ name: "Dear Lagos eggs", priceKobo: 9_000_00, state: "lagos" });
    await insertProduct({ name: "Oyo eggs", priceKobo: 3_000_00, state: "oyo" });
    await insertProduct({ name: "Lagos birds", category: "live-birds", priceKobo: 3_000_00, state: "lagos" });

    expect(await names({ category: "eggs" })).toHaveLength(3);
    expect(await names({ state: "lagos" })).toEqual(["Lagos birds", "Dear Lagos eggs", "Cheap Lagos eggs"]);
    expect(await names({ minPrice: "2500", maxPrice: "5000" })).toEqual(["Lagos birds", "Oyo eggs"]);
    expect(await names({ minPrice: "2000", maxPrice: "2000" })).toEqual(["Cheap Lagos eggs"]);
    expect(await names({ category: "eggs", state: "lagos", maxPrice: "5000" })).toEqual(["Cheap Lagos eggs"]);
  });

  it("shows listings without a location everywhere except under a state filter", async () => {
    await insertProduct({ name: "Lagos eggs", state: "lagos" });
    await insertProduct({ name: "Somewhere eggs", state: null });
    const legacy = await insertProduct({ name: "Old eggs" });
    await (await collections()).products.updateOne({ _id: legacy._id }, { $unset: { state: "", area: "" } });

    expect(await names()).toEqual(["Old eggs", "Somewhere eggs", "Lagos eggs"]);
    expect(await names({ near: "oyo" })).toHaveLength(3); // a preference never hides anything
    expect(await names({ state: "lagos" })).toEqual(["Lagos eggs"]);
    expect(await names({ state: "kano" })).toEqual([]);
  });

  it("filters on published reviews only, leaving unreviewed products out", async () => {
    const great = await insertProduct({ name: "Great eggs" });
    const fair = await insertProduct({ name: "Fair eggs" });
    await insertProduct({ name: "New eggs" });
    await insertReview(great, 5);
    await insertReview(great, 4);
    await insertReview(fair, 3);
    await insertReview(fair, 5, "withdrawn");
    await insertReview(fair, 5, "pending");
    await insertReview(fair, 1, "rejected");
    const db = await getDb();
    await refreshProductRating(db, great._id);
    await refreshProductRating(db, fair._id);

    expect(await names({ minRating: "4" })).toEqual(["Great eggs"]);
    expect(await names({ minRating: "3" })).toEqual(["Fair eggs", "Great eggs"]);
    const results = await search();
    expect(results.products.find((p) => p.name === "Great eggs")!.rating).toEqual({ average: 4.5, count: 2 });
    expect(results.products.find((p) => p.name === "Fair eggs")!.rating).toEqual({ average: 3, count: 1 });
    expect(results.products.find((p) => p.name === "New eggs")!.rating).toBeNull();
  });
});

// --- order ------------------------------------------------------------------------------------

describe("sorting and paging", () => {
  it("sorts by price, newest and rating, with stable ties", async () => {
    const a = await insertProduct({ name: "A", priceKobo: 3_000_00 });
    const b = await insertProduct({ name: "B", priceKobo: 1_000_00 });
    const c = await insertProduct({ name: "C", priceKobo: 3_000_00 });
    const d = await insertProduct({ name: "D", priceKobo: 2_000_00 });

    expect(await names({ sort: "newest" })).toEqual(["D", "C", "B", "A"]);
    expect(await names({ sort: "price_asc" })).toEqual(["B", "D", "C", "A"]);
    expect(await names({ sort: "price_desc" })).toEqual(["A", "C", "D", "B"]);

    await insertReview(a, 4);
    await insertReview(b, 5);
    await insertReview(c, 4);
    await insertReview(c, 4);
    const db = await getDb();
    for (const p of [a, b, c, d]) await refreshProductRating(db, p._id);
    // highest average, then more reviews, then newest; unrated last
    expect(await names({ sort: "rating" })).toEqual(["B", "C", "A", "D"]);
  });

  it("recommends newest first, putting the preferred state ahead without hiding the rest", async () => {
    await insertProduct({ name: "Oyo old", state: "oyo" });
    await insertProduct({ name: "Lagos", state: "lagos" });
    await insertProduct({ name: "Oyo new", state: "oyo" });
    await insertProduct({ name: "Unknown" });
    expect(await names()).toEqual(["Unknown", "Oyo new", "Lagos", "Oyo old"]);
    expect(await names({ near: "oyo" })).toEqual(["Oyo new", "Oyo old", "Unknown", "Lagos"]);
  });

  it("boosts keyword matches from the preferred state modestly", async () => {
    await insertProduct({ name: "Layer eggs", state: "lagos" });
    await insertProduct({ name: "Layer eggs", state: "oyo" });
    await insertProduct({ name: "Eggs", description: "From layers", state: "oyo" });
    const lagosFirst = await search({ q: "layer", near: "lagos" });
    expect(lagosFirst.products.map((p) => p.state)).toEqual(["lagos", "oyo", "oyo"]);
    const oyoFirst = await search({ q: "layer", near: "oyo" });
    // the boost reorders equal matches, but a name match still beats a description one
    expect(oyoFirst.products.map((p) => `${p.name}/${p.state}`)).toEqual(["Layer eggs/oyo", "Layer eggs/lagos", "Eggs/oyo"]);
  });

  it("pages through every result exactly once, with a count", async () => {
    const total = MARKET_LIMITS.pageSize * 2 + 5;
    await (await collections()).products.insertMany(
      Array.from({ length: total }, (_, i) => ({
        _id: new ObjectId(),
        sellerUserId: sellerId,
        name: `Crate ${i}`,
        category: "eggs" as const,
        description: "",
        unit: "crate" as const,
        priceKobo: 1_000_00 * (1 + (i % 3)), // many equal prices
        stockQuantity: 5,
        active: true,
        archivedAt: null,
        state: null,
        area: "",
        searchTerms: searchTermsFor("eggs"),
        ratingCount: 0,
        ratingAverage: null,
        createdAt: new Date(clock), // all at the same moment
        updatedAt: new Date(clock),
      })),
    );
    for (const sort of ["recommended", "price_asc", "price_desc", "rating"]) {
      const seen: string[] = [];
      for (let page = 1; ; page++) {
        const results = await search({ sort, page: String(page) });
        expect(results.total).toBe(total);
        expect(results.totalCapped).toBe(false);
        expect(results.products.length).toBeLessThanOrEqual(MARKET_LIMITS.pageSize);
        seen.push(...results.products.map((p) => p.id));
        if (!results.hasMore) break;
      }
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    }
    const last = await search({ page: "3" });
    expect(last.products).toHaveLength(5);
    expect(last.hasMore).toBe(false);
    expect((await search({ page: "4" })).products).toEqual([]);
  });
});

// --- what a result shows ---------------------------------------------------------------------

describe("results", () => {
  it("shows the seller's name and location, and marks the viewer's own listings", async () => {
    const seller = await merchant("poultry-farmer");
    const res = await call<ProductResponse>(addProductRoute, "/api/products", {
      cookie: seller.cookie,
      body: {
        name: "Point of lay hens",
        category: "live-birds",
        unit: "bird",
        priceKobo: 6_000_00,
        stockQuantity: 20,
        description: "",
        state: "oyo",
        area: "  Ogbomoso  ",
      },
    });
    expect(res.status).toBe(201);
    const { product } = dataOf(res);
    expect(product).toMatchObject({ state: "oyo", area: "Ogbomoso" });

    const [found] = (await searchMarket(viewer, parseMarketQuery({ q: "hens" }))).products;
    expect(found).toMatchObject({ id: product.id, state: "oyo", area: "Ogbomoso", own: false, rating: null });
    expect(found.sellerName).toBeTruthy();
    expect(found).not.toHaveProperty("sellerUserId");
    expect((await searchMarket(seller.userId, parseMarketQuery({ q: "hens" }))).products[0].own).toBe(true);
    // the category's words were stored for search, not taken from the request
    const stored = await (await collections()).products.findOne({ _id: new ObjectId(product.id) });
    expect(stored).toMatchObject({ searchTerms: searchTermsFor("live-birds"), ratingCount: 0, ratingAverage: null });
  });

  it("returns a controlled failure when the database can't be searched", async () => {
    const spy = vi.spyOn(Collection.prototype, "aggregate").mockImplementation(() => {
      throw Object.assign(new Error("connection refused at mongodb://secret-host"), { name: "MongoNetworkError" });
    });
    try {
      expect(await trySearchMarket(viewer, query({ q: "eggs" }))).toBeNull();
      const logged = vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("[market-search] failed: MongoNetworkError");
      expect(logged).not.toContain("secret-host");
      expect(logged).not.toContain("eggs");
    } finally {
      spy.mockRestore();
    }
  });
});

// --- listing locations ------------------------------------------------------------------------

describe("listing locations", () => {
  const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 10, description: "" };

  it("accepts only states from the catalogue, and lets the seller clear one", async () => {
    const seller = await merchant("poultry-farmer");
    const bad = await call(addProductRoute, "/api/products", { cookie: seller.cookie, body: { ...EGGS, state: "Lagos State" } });
    expect(bad.status).toBe(400);
    expect(fieldErrorsOf(bad)).toHaveProperty("state");
    const tooLong = await call(addProductRoute, "/api/products", { cookie: seller.cookie, body: { ...EGGS, area: "x".repeat(61) } });
    expect(tooLong.status).toBe(400);
    expect(fieldErrorsOf(tooLong)).toHaveProperty("area");

    const { product } = dataOf(
      await call<ProductResponse>(addProductRoute, "/api/products", { cookie: seller.cookie, body: { ...EGGS, state: "kano" } }),
    );
    const patch = (body: unknown) =>
      callId<ProductResponse>(editRoute, `/api/products/${product.id}`, product.id, { cookie: seller.cookie, body, method: "PATCH" });
    expect((await patch({ state: 12 })).status).toBe(400);
    expect(dataOf(await patch({ state: null })).product.state).toBeNull();
    expect(dataOf(await patch({ state: "fct", area: "Gwagwalada" })).product).toMatchObject({ state: "fct", area: "Gwagwalada" });

    // a category change updates what the listing is found by
    await patch({ category: "manure" });
    expect(await names({ q: "compost" })).toEqual(["Fresh eggs"]);
    expect(await names({ q: "crate" })).toEqual([]);
  });

  it("defaults new listings to no location", async () => {
    const seller = await merchant("poultry-farmer");
    const { product } = dataOf(await call<ProductResponse>(addProductRoute, "/api/products", { cookie: seller.cookie, body: EGGS }));
    expect(product).toMatchObject({ state: null, area: "" });
  });
});

// --- derived data -------------------------------------------------------------------------------

describe("rebuilding search data", () => {
  it("backfills listings saved before search existed", async () => {
    const legacy = await insertProduct({ name: "Old birds", category: "live-birds" });
    await (await collections()).products.updateOne(
      { _id: legacy._id },
      { $unset: { searchTerms: "", ratingCount: "", ratingAverage: "", state: "", area: "" } },
    );
    await insertReview(legacy, 4);
    await insertReview(legacy, 2);
    await insertReview(legacy, 5, "withdrawn");
    expect(await names({ q: "broilers" })).toEqual([]);

    expect(await rebuildCatalogSearch(await getDb(), 1)).toEqual({ products: 1 });
    expect(await names({ q: "broilers" })).toEqual(["Old birds"]);
    expect((await search()).products[0].rating).toEqual({ average: 3, count: 2 });
    // running it again changes nothing
    await rebuildCatalogSearch(await getDb());
    expect((await search()).products[0].rating).toEqual({ average: 3, count: 2 });
  });

  it("never lets an older refresh overwrite a newer one", async () => {
    const product = await insertProduct();
    const products = (await collections()).products;
    await insertReview(product, 5);
    const db = await getDb();
    await refreshProductRating(db, product._id);
    // a refresh that started earlier (an older generation) arrives late
    const late = await products.updateOne(
      { _id: product._id, ratingGen: 0 },
      { $set: { ratingCount: 0, ratingAverage: null } },
    );
    expect(late.modifiedCount).toBe(0);
    expect(await products.findOne({ _id: product._id })).toMatchObject({ ratingCount: 1, ratingAverage: 5, ratingGen: 1 });
  });
});

// --- through the real review and order flow --------------------------------------------------

describe("ratings and buying from search results", () => {
  const NOTE = "Deliver to 12 Ring Road, Ibadan. Call on arrival.";

  async function deliveredOrder(sellerCookie: string, productId: string) {
    const customer = await merchant("veterinarian");
    const placed = await call<OrderResponse>(placeRoute, "/api/orders", {
      cookie: customer.cookie,
      body: { items: [{ productId, quantity: 1 }], deliveryNote: NOTE, idempotencyKey: randomUUID() },
    });
    expect(placed.status).toBe(201);
    const order = dataOf(placed).order;
    const { reference } = dataOf(
      await callId<CheckoutResponse>(checkoutRoute, `/api/orders/${order.id}/checkout`, order.id, { cookie: customer.cookie, body: {} }),
    );
    completeCheckout(reference);
    const verified = await callId<VerifyPaymentResponse>(verifyRoute, `/api/orders/${order.id}/verify-payment`, order.id, {
      cookie: customer.cookie,
      body: { reference },
    });
    expect(dataOf(verified).result).toBe("paid");
    for (const action of ["accept", "ship", "deliver"])
      expect(
        (await callId(fulfilRoute, `/api/sales/${order.id}/fulfillment`, order.id, { cookie: sellerCookie, body: { action } })).status,
      ).toBe(200);
    return customer;
  }

  it("keeps the rating in step as reviews are posted and withdrawn", async () => {
    const seller = await merchant("poultry-farmer");
    const { product } = dataOf(
      await call<ProductResponse>(addProductRoute, "/api/products", {
        cookie: seller.cookie,
        body: { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 10, description: "" },
      }),
    );
    const customer = await deliveredOrder(seller.cookie, product.id);
    const posted = await callId<ReviewResponse>(postReviewRoute, `/api/products/${product.id}/reviews`, product.id, {
      cookie: customer.cookie,
      body: { rating: 4, text: "Fresh and well packed." },
    });
    expect(posted.status).toBe(201);
    expect((await search({ minRating: "4" })).products.map((p) => p.rating)).toEqual([{ average: 4, count: 1 }]);

    const id = dataOf(posted).review.id;
    expect((await callId(withdrawRoute, `/api/reviews/${id}`, id, { cookie: customer.cookie, method: "DELETE" })).status).toBe(200);
    expect(await names({ minRating: "1" })).toEqual([]);
    expect((await search()).products[0].rating).toBeNull();
  });

  it("re-reads the price at checkout and won't sell a seller their own listing", async () => {
    const seller = await merchant("poultry-farmer");
    const { product } = dataOf(
      await call<ProductResponse>(addProductRoute, "/api/products", {
        cookie: seller.cookie,
        body: { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 10, description: "" },
      }),
    );
    const [seen] = (await search({ q: "eggs" })).products;
    expect(seen.priceKobo).toBe(4_500_00);
    // the seller raises the price after the buyer saw the result
    await callId(editRoute, `/api/products/${product.id}`, product.id, {
      cookie: seller.cookie,
      body: { priceKobo: 5_000_00 },
      method: "PATCH",
    });
    const customer = await merchant("veterinarian");
    const stale = await call(placeRoute, "/api/orders", {
      cookie: customer.cookie,
      body: { items: [{ productId: seen.id, quantity: 1 }], deliveryNote: NOTE, idempotencyKey: randomUUID(), expectedTotalKobo: seen.priceKobo },
    });
    expect(stale.status).toBe(409);

    const own = await call(placeRoute, "/api/orders", {
      cookie: seller.cookie,
      body: { items: [{ productId: product.id, quantity: 1 }], deliveryNote: NOTE, idempotencyKey: randomUUID() },
    });
    expect(own.status).toBe(400);
  });
});
