import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { searchCatalog, TRAINING_UNVERIFIED } from "@/lib/server/training";
import { parseCatalogQuery } from "@/lib/training/query";
import { CATALOG_MAX_PAGE_SIZE, CATALOG_PAGE_SIZE, type CatalogPage } from "@/lib/training/types";

// Korret Academy: one page of published courses matching ?q, ?category and
// ?difficulty. Keyset paged: pass `cursor` from the previous page with the
// same filters (a cursor from another search is refused). Drafts never appear.

export const GET = route("training/courses", async (request) => {
  const { user } = await requireVerifiedRequest(request, TRAINING_UNVERIFIED);
  const params = new URL(request.url).searchParams;
  const { query, invalid } = parseCatalogQuery(params);
  const fieldErrors: Record<string, string> = Object.fromEntries(invalid.map((key) => [key, "Unknown value."]));
  const rawLimit = params.get("limit");
  let limit = CATALOG_PAGE_SIZE;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > CATALOG_MAX_PAGE_SIZE)
      fieldErrors.limit = `Use a page size from 1 to ${CATALOG_MAX_PAGE_SIZE}.`;
  }
  const cursor = params.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 300)) fieldErrors.cursor = "Start the search again.";
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Please check the search filters.", fieldErrors);
  await limitUser("trainingReadsPerUser", user._id, "Too many searches. Please wait a moment and try again.");
  return ok<CatalogPage>(await searchCatalog(query, cursor, limit));
});
