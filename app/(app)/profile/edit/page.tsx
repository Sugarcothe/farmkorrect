import type { Metadata } from "next";
import { EditProfileForm } from "@/components/profile/edit-profile-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getProfile } from "@/lib/server/profile";

export const metadata: Metadata = { title: "Edit Profile" };

export default async function EditProfilePage() {
  const { user } = await requireVerifiedPageSession();
  return <EditProfileForm profile={await getProfile(user)} />;
}
