"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Image from "next/image";
import { FormAlert } from "@/components/auth/auth-screen";
import { Icon } from "@/components/ui/icons";
import { removePhoto, setMainPhoto, uploadProductPhoto } from "@/lib/orders/api";
import { checkPhotoFile, photoUrl } from "@/lib/orders/photos";
import { PRODUCT_PHOTO_RULES, type ProductImage } from "@/lib/orders/types";

// Choosing a listing's photos. A new listing keeps them in a queue (shown from
// the device, nothing sent) until the listing is saved; an existing listing
// changes straight away and only shows what the server confirmed.

const MAX = PRODUCT_PHOTO_RULES.maxPhotos;
const ACCEPT = PRODUCT_PHOTO_RULES.types.join(",");

export type QueuedPhoto = {
  key: string;
  file: File;
  /** an object URL for the preview, revoked when the photo leaves the queue */
  preview: string;
  status: "waiting" | "uploading" | "failed";
  /** 0 to 1 while uploading */
  progress: number;
  error?: string;
};

export function queuePhoto(file: File): QueuedPhoto {
  return { key: crypto.randomUUID(), file, preview: URL.createObjectURL(file), status: "waiting", progress: 0 };
}

/** Splits picked files into ones that can be queued and a message about the rest. */
function pickFiles(files: File[], room: number): { accepted: File[]; problem: string | null } {
  const accepted: File[] = [];
  let problem: string | null = null;
  for (const file of files) {
    const error = checkPhotoFile(file);
    if (error) problem = `${file.name}: ${error}`;
    else if (accepted.length >= room) problem = `You can add up to ${MAX} photos. Remove one to add another.`;
    else accepted.push(file);
  }
  return { accepted, problem };
}

const tileButton =
  "flex size-9 items-center justify-center rounded-full text-foreground/70 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";

function Tile({
  src,
  index,
  total,
  main,
  progress,
  error,
  disabled,
  onMain,
  onRemove,
  removeLabel,
}: {
  src: string;
  index: number;
  total: number;
  main: boolean;
  /** shown as a bar while uploading */
  progress?: number;
  error?: string;
  disabled: boolean;
  onMain?: () => void;
  onRemove: () => void;
  removeLabel?: string;
}) {
  const name = `photo ${index + 1} of ${total}`;
  return (
    <li className="flex flex-col">
      <div className="relative aspect-square overflow-hidden rounded-2xl bg-primary/8 ring-1 ring-foreground/8">
        <Image src={src} alt={`Product ${name}`} fill sizes="120px" unoptimized className="object-cover" />
        {main && (
          <span className="absolute top-1.5 left-1.5 rounded-full bg-primary px-2 py-0.5 text-[0.6875rem] font-semibold text-primary-foreground">
            Main
          </span>
        )}
        {progress !== undefined && (
          <span className="absolute inset-x-2 bottom-2 h-1.5 overflow-hidden rounded-full bg-white/80">
            <span
              role="progressbar"
              aria-label={`Uploading ${name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              className="block h-full bg-primary transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-[0.6875rem] leading-snug text-red-600">{error}</p>}
      <div className="mt-1 flex justify-center gap-1">
        {onMain && (
          <button
            type="button"
            onClick={onMain}
            disabled={disabled || main}
            aria-label={main ? `${name} is the main photo` : `Make ${name} the main photo`}
            aria-pressed={main}
            className={tileButton}
          >
            <Icon name="star" className={`size-4 ${main ? "fill-current text-primary" : ""}`} />
          </button>
        )}
        <button type="button" onClick={onRemove} disabled={disabled} aria-label={removeLabel ?? `Remove ${name}`} className={tileButton}>
          <Icon name="trash" className="size-4" />
        </button>
      </div>
    </li>
  );
}

function AddButton({ room, disabled, onFiles }: { room: number; disabled: boolean; onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  function change(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // so the same file can be picked again
    if (files.length) onFiles(files);
  }
  if (room <= 0) return null;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-foreground/15 text-xs font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon name="camera" className="size-5" />
        Add photo
      </button>
      <input ref={inputRef} type="file" accept={ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={change} />
    </li>
  );
}

function Frame({ count, children, message }: { count: number; children: React.ReactNode; message: string | null }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">Photos (optional)</legend>
      <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
        {count === 0
          ? `No photos yet. Add up to ${MAX} real photos of what you're selling (JPG, PNG or WebP, under ${PRODUCT_PHOTO_RULES.maxBytes / (1024 * 1024)} MB each).`
          : `${count} of ${MAX}. The main photo is shown in the Market.`}
      </p>
      <ul className="grid grid-cols-3 gap-2">{children}</ul>
      <div aria-live="polite">{message && <p className="mt-2 text-xs text-red-600">{message}</p>}</div>
    </fieldset>
  );
}

/** A new listing's photos, uploaded by the form once the listing is saved. */
export function PhotoQueue({
  queue,
  onChange,
  disabled,
}: {
  queue: QueuedPhoto[];
  onChange: (queue: QueuedPhoto[]) => void;
  disabled: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);

  function add(files: File[]) {
    const { accepted, problem } = pickFiles(files, MAX - queue.length);
    setMessage(problem);
    if (accepted.length) onChange([...queue, ...accepted.map(queuePhoto)]);
  }

  function remove(key: string) {
    const photo = queue.find((p) => p.key === key);
    if (photo) URL.revokeObjectURL(photo.preview);
    onChange(queue.filter((p) => p.key !== key));
  }

  function makeMain(key: string) {
    const photo = queue.find((p) => p.key === key);
    if (photo) onChange([photo, ...queue.filter((p) => p.key !== key)]);
  }

  return (
    <Frame count={queue.length} message={message}>
      {queue.map((p, i) => (
        <Tile
          key={p.key}
          src={p.preview}
          index={i}
          total={queue.length}
          main={i === 0}
          progress={p.status === "uploading" ? p.progress : undefined}
          error={p.error}
          disabled={disabled}
          onMain={() => makeMain(p.key)}
          onRemove={() => remove(p.key)}
        />
      ))}
      <AddButton room={MAX - queue.length} disabled={disabled} onFiles={add} />
    </Frame>
  );
}

/**
 * An existing listing's photos. Every change is sent straight away and the
 * list shown is the one the server sends back. `onBusy` reports whether an
 * upload or change is still in progress (leaving would lose it).
 */
export function PhotoManager({
  productId,
  initial,
  notice,
  onBusy,
}: {
  productId: string;
  initial: ProductImage[];
  /** shown once, e.g. after a new listing's photos failed to upload */
  notice?: string;
  onBusy: (busy: boolean) => void;
}) {
  const [images, setImages] = useState(initial);
  const [pending, setPending] = useState<QueuedPhoto[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const uploading = useRef(false);
  const toUpload = useRef<QueuedPhoto[]>([]);
  const previews = useRef(new Set<string>());

  const busy = working !== null || pending.some((p) => p.status !== "failed");
  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const update = (key: string, change: Partial<QueuedPhoto>) =>
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));

  function forget(key: string) {
    setPending((list) => {
      const photo = list.find((p) => p.key === key);
      if (photo) {
        URL.revokeObjectURL(photo.preview);
        previews.current.delete(photo.preview);
      }
      return list.filter((p) => p.key !== key);
    });
  }

  // one upload at a time, in the order they were picked
  async function pump() {
    if (uploading.current) return;
    uploading.current = true;
    while (toUpload.current.length) {
      const photo = toUpload.current.shift()!;
      update(photo.key, { status: "uploading", progress: 0, error: undefined });
      const res = await uploadProductPhoto(productId, photo.file, (progress) => update(photo.key, { progress }));
      if (res.ok) {
        setImages(res.data.product.images);
        forget(photo.key);
      } else update(photo.key, { status: "failed", error: res.error });
    }
    uploading.current = false;
  }

  function upload(list: QueuedPhoto[]) {
    for (const p of list) update(p.key, { status: "waiting", progress: 0, error: undefined });
    toUpload.current.push(...list);
    void pump();
  }

  function add(files: File[]) {
    const { accepted, problem } = pickFiles(files, MAX - images.length - pending.length);
    setMessage(problem);
    if (!accepted.length) return;
    const added = accepted.map(queuePhoto);
    added.forEach((p) => previews.current.add(p.preview));
    setPending((list) => [...list, ...added]);
    upload(added);
  }

  async function act(imageId: string, action: "main" | "remove") {
    if (working) return;
    if (action === "remove" && !window.confirm("Remove this photo from the listing?")) return;
    setWorking(imageId);
    setMessage(null);
    const res = action === "main" ? await setMainPhoto(productId, imageId) : await removePhoto(productId, imageId);
    setWorking(null);
    if (res.ok) setImages(res.data.product.images);
    else setMessage(res.error);
  }

  const total = images.length + pending.length;
  return (
    <div className="space-y-2">
      {notice && <FormAlert>{notice}</FormAlert>}
      <Frame count={total} message={message}>
        {images.map((image, i) => (
          <Tile
            key={image.id}
            src={photoUrl(image.url, 240)}
            index={i}
            total={total}
            main={i === 0}
            disabled={working !== null}
            onMain={() => act(image.id, "main")}
            onRemove={() => act(image.id, "remove")}
          />
        ))}
        {pending.map((p, i) => (
          <Tile
            key={p.key}
            src={p.preview}
            index={images.length + i}
            total={total}
            main={false}
            progress={p.status === "failed" ? undefined : p.progress}
            error={p.error}
            disabled={p.status !== "failed"}
            onRemove={() => forget(p.key)}
            removeLabel={`Discard photo ${images.length + i + 1}, which wasn't uploaded`}
          />
        ))}
        <AddButton room={MAX - total} disabled={working !== null} onFiles={add} />
      </Frame>
      {pending.some((p) => p.status === "failed") && (
        <button
          type="button"
          onClick={() => upload(pending.filter((p) => p.status === "failed"))}
          className="text-xs font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
        >
          Try the failed uploads again
        </button>
      )}
    </div>
  );
}
