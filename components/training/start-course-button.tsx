"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { lessonHref } from "@/components/training/training-parts";
import { enrollInCourse } from "@/lib/training/api";

/** Start or Resume: the server records the enrolment and says which lesson to open. */
export function StartCourseButton({ courseId, label }: { courseId: string; label: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setError(null);
    const result = await enrollInCourse(courseId);
    if (!result.ok) {
      setLoading(false);
      setError(result.error);
      return;
    }
    if (!result.data.resumeLessonId) {
      setLoading(false);
      setError("This course has no lessons yet.");
      return;
    }
    router.push(lessonHref(courseId, result.data.resumeLessonId));
  }

  return (
    <div className="space-y-2">
      {error && <FormAlert>{error}</FormAlert>}
      <Button type="button" loading={loading} onClick={start}>
        {loading ? "Opening…" : label}
      </Button>
    </div>
  );
}
