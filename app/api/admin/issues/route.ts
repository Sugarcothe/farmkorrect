import type { IssuePage } from "@/lib/admin/types";
import { requireAdminCapability } from "@/lib/server/admin";
import { listIssues } from "@/lib/server/admin-queues";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// Order issues buyers reported: ?state=open (default, oldest first) or closed.

export const GET = route("admin/issues", async (request) => {
  const { user } = await requireAdminCapability(request, "admin.order_issues.read");
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? "open";
  if (state !== "open" && state !== "closed")
    throw new HttpError(400, "Please correct the filters.", { state: "Choose open or closed." });
  const page = parsePage(params);
  await limitUser("adminReadsPerUser", user._id);
  return ok<IssuePage>(await listIssues(state, page));
});
