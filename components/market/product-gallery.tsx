import type { ProductImage } from "@/lib/orders/types";
import { ProductPhoto } from "./product-photo";

/**
 * All of a listing's photos, main one first, in a row that scrolls (or
 * swipes) sideways. A listing without photos shows the plain placeholder.
 */
export function ProductGallery({ name, images }: { name: string; images: ProductImage[] }) {
  const frame = "relative aspect-[4/3] overflow-hidden rounded-3xl bg-primary/8 ring-1 ring-foreground/5";
  if (images.length === 0)
    return (
      <div className={frame}>
        <ProductPhoto image={undefined} alt={name} width={800} sizes="100vw" />
      </div>
    );
  const many = images.length > 1;
  return (
    <section aria-label={`Photos of ${name}`}>
      <ul
        // focusable so the row can be scrolled with the arrow keys
        tabIndex={many ? 0 : undefined}
        className="-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-accent"
      >
        {images.map((image, i) => (
          <li key={image.id} className={`${frame} shrink-0 snap-center ${many ? "w-[85%]" : "w-full"}`}>
            <ProductPhoto
              image={image}
              alt={many ? `${name}, photo ${i + 1} of ${images.length}` : name}
              width={1200}
              sizes="(min-width: 420px) 380px, 90vw"
              priority={i === 0}
              fit="contain"
            />
          </li>
        ))}
      </ul>
      {many && <p className="mt-1.5 text-center text-xs text-muted-foreground">{images.length} photos · swipe for more</p>}
    </section>
  );
}
