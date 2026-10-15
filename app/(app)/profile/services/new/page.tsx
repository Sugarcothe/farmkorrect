import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ServiceForm } from "@/components/services/service-form";
import { offersServices } from "@/lib/services/config";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Add New Service" };

export default async function NewServicePage() {
  const { user } = await requireVerifiedPageSession();
  if (!offersServices(user.role)) redirect("/profile/services");
  return <ServiceForm role={user.role} />;
}
