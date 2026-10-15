import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ServiceForm } from "@/components/services/service-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findOwnService, toService } from "@/lib/server/services";

export const metadata: Metadata = { title: "Edit Service" };

// Only the signed-in owner's own, current service can be edited; any other id
// (someone else's, removed or made up) is a 404.
export default async function EditServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const service = await findOwnService(user._id, (await params).id);
  if (!service) notFound();
  return <ServiceForm role={user.role} service={toService(service)} />;
}
