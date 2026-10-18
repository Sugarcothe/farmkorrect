import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { searchDirectory, VETS_UNVERIFIED } from "@/lib/server/vet-directory";
import { parseDirectoryQuery } from "@/lib/vets/query";
import { DIRECTORY_MAX_PAGE_SIZE, DIRECTORY_PAGE_SIZE, type DirectoryPage } from "@/lib/vets/types";

// Find a Vet: one page of verified, listed vets matching the filters.
// Keyset paged: pass `cursor` from the previous page with the same filters
// (a cursor from another search is refused). No total count is returned.

export const GET = route("vets", async (request) => {
  const { user } = await requireVerifiedRequest(request, VETS_UNVERIFIED);
  const params = new URL(request.url).searchParams;
  const { query, invalid } = parseDirectoryQuery(params);
  const fieldErrors: Record<string, string> = Object.fromEntries(invalid.map((key) => [key, "Unknown value."]));
  const rawLimit = params.get("limit");
  let limit = DIRECTORY_PAGE_SIZE;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > DIRECTORY_MAX_PAGE_SIZE)
      fieldErrors.limit = `Use a page size from 1 to ${DIRECTORY_MAX_PAGE_SIZE}.`;
  }
  const cursor = params.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 300)) fieldErrors.cursor = "Start the search again.";
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Please check the search filters.", fieldErrors);
  await limitUser("vetSearchesPerUser", user._id, "Too many searches. Please wait a moment and try again.");
  return ok<DirectoryPage>(await searchDirectory(query, cursor, limit));
});
