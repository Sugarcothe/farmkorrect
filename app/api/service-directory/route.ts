import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { searchServiceDirectory, SERVICE_DIRECTORY_UNVERIFIED } from "@/lib/server/service-directory";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import {
  parseServiceQuery,
  SERVICE_DIRECTORY_MAX_PAGE_SIZE,
  SERVICE_DIRECTORY_PAGE_SIZE,
  type ServiceDirectoryPage,
} from "@/lib/services/marketplace";

// Other Services: one page of listed marketplace services matching the
// filters, newest first. Keyset paged: pass `cursor` from the previous page
// with the same filters (a cursor from another search is refused). No total
// count is returned.

export const GET = route("service-directory", async (request) => {
  const { user } = await requireVerifiedRequest(request, SERVICE_DIRECTORY_UNVERIFIED);
  const params = new URL(request.url).searchParams;
  const { query, invalid } = parseServiceQuery(params);
  const fieldErrors: Record<string, string> = Object.fromEntries(invalid.map((key) => [key, "Unknown value."]));
  const rawLimit = params.get("limit");
  let limit = SERVICE_DIRECTORY_PAGE_SIZE;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!/^\d{1,3}$/.test(rawLimit) || limit < 1 || limit > SERVICE_DIRECTORY_MAX_PAGE_SIZE)
      fieldErrors.limit = `Use a page size from 1 to ${SERVICE_DIRECTORY_MAX_PAGE_SIZE}.`;
  }
  const cursor = params.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 300)) fieldErrors.cursor = "Start the search again.";
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Please check the search filters.", fieldErrors);
  await limitUser("serviceSearchesPerUser", user._id, "Too many searches. Please wait a moment and try again.");
  return ok<ServiceDirectoryPage>(await searchServiceDirectory(query, cursor, limit));
});
