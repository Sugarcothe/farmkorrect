"use client";

import { useState } from "react";
import Image from "next/image";
import { Icon } from "@/components/ui/icons";
import { photoUrl } from "@/lib/orders/photos";
import type { ProductImage } from "@/lib/orders/types";

type ProductPhotoProps = {
  image: ProductImage | undefined;
  alt: string;
  /** the width to fetch, in pixels (Cloudinary makes the smaller copy) */
  width: number;
  sizes: string;
  /** the first photo on screen loads straight away; the rest wait until they're near */
  priority?: boolean;
  /** "cover" fills the frame (cards); "contain" shows the whole photo (gallery) */
  fit?: "cover" | "contain";
};

/**
 * A product photo filling its (relatively positioned) parent. Listings
 * without photos, or whose photo fails to load, show a plain placeholder:
 * never a stock picture.
 */
export function ProductPhoto({ image, alt, width, sizes, priority, fit = "cover" }: ProductPhotoProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!image || failedUrl === image.url)
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-primary/8 text-primary">
        <Icon name="egg" className="size-7" />
        {image && <span className="text-[0.6875rem] text-foreground/55">Photo unavailable</span>}
        <span className="sr-only">{image ? `Photo of ${alt} couldn't be loaded` : "No photo"}</span>
      </span>
    );
  return (
    <Image
      src={photoUrl(image.url, width)}
      alt={alt}
      fill
      sizes={sizes}
      unoptimized
      priority={priority}
      loading={priority ? undefined : "lazy"}
      onError={() => setFailedUrl(image.url)}
      className={fit === "cover" ? "object-cover" : "object-contain"}
    />
  );
}
