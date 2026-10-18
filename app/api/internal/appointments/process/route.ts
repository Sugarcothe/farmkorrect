import { runAppointmentJob } from "@/lib/server/appointments";
import { ok, route } from "@/lib/server/http";
import { requireOrderJobSecret } from "@/lib/server/order-access";

// Called by the same scheduler as the order job, with an
// "Authorization: Bearer <ORDER_JOB_SECRET>" header. It lapses vet requests
// that weren't answered in time (giving their time back), clears leftover
// holds and rebuilds directory entries that are due. The route can't be
// reached at all while ORDER_JOB_SECRET is unset.

export const POST = route("internal/appointments/process", async (request) => {
  requireOrderJobSecret(request);
  return ok(await runAppointmentJob());
});
