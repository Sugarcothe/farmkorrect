# Product photos and pickup/delivery options

This page covers Milestone 9: sellers can add photos to their listings and say how buyers get their goods (pickup, seller-arranged delivery, or both). Buyers choose one of those when they order.

## Product photos

### Storage

- The image files are stored on **Cloudinary**, using the signed Upload API that profile photos already use (`lib/server/cloudinary.ts`). MongoDB only holds references. Each product's `images` array contains `{ id, publicId, url, width, height, addedAt }`, and the main photo is first.
- The `id` (16 hex characters) and the Cloudinary `publicId` are generated on the server. The browser never sees a `publicId`; the API sends `{ id, url, width, height }`.
- Listing photos go next to the profile-photo folder. With the default `CLOUDINARY_FOLDER` (`farm-korret/avatars`) they are stored under `farm-korret/products/`. A custom folder that doesn't end in `/avatars` gets a `products/` subfolder.

### Limits and checks (server-side)

Each photo goes through these checks in order:

| Check | Limit | Response |
|---|---|---|
| Cloudinary configured | all three `CLOUDINARY_*` credentials set | 503 |
| Declared `Content-Type` | `image/jpeg`, `image/png` or `image/webp` | 415 |
| Upload rate | 60 photos per seller per hour | 429 |
| Listing | must be the seller's own, not archived | 404 |
| Photos per listing | 5 (checked first, then again inside the database write so simultaneous uploads can't go over) | 409 |
| Size | 8 MB | 413 |
| Content | file signature must match the declared type; empty or undecodable files are rejected | 400 |
| Dimensions | 40 megapixels at most, checked before decoding | 400 |

Processing uses **sharp**. The image is rotated upright according to its EXIF orientation, then resized to fit within 1600×1600. It is never cropped or enlarged. It is re-encoded as WebP at quality 80. Metadata (EXIF, GPS, camera details) is removed. Only this cleaned file is sent to Cloudinary.

### Routes

All of these routes require a same-origin request, a verified session and a poultry-farmer account. The owner is always taken from the session, never from the request.

- `POST /api/products/:id/images`: the body is the raw image bytes. Returns `201 { product }`.
- `PATCH /api/products/:id/images/:imageId`: body `{ "primary": true }`, which makes this photo the main one. Any other field is rejected.
- `DELETE /api/products/:id/images/:imageId`: removes the photo.

A listing that belongs to someone else returns the same 404 as one that doesn't exist. Photos can't be changed through `PATCH /api/products/:id`.

### Keeping the database and Cloudinary in step

- **Adding a photo.** The file is uploaded first, then recorded on the listing. If the database write fails, or the listing was archived or filled up in the meantime, the uploaded file is deleted again.
- **Removing a photo.** It is taken off the listing first, and the Cloudinary file is deleted only after that succeeds. A listing therefore never points at a deleted file.
- **Known gap.** If Cloudinary fails to delete a file after a removal, that file stays in Cloudinary unused. It is not visible anywhere in the app. Archived listings keep their photos, because the files are still referenced. There is no cleanup job for either case yet.

### Where photos appear

- **Market cards** show the main photo. Search results only load the first photo.
- **Product page** shows a swipeable gallery of all the photos.
- **Seller's listings page** shows a small thumbnail of the main photo.
- **Fallback.** A listing with no photos, or a photo that fails to load, shows a plain placeholder. No stock images are used.
- Images have alt text, load lazily and use Cloudinary's `c_limit` resizing.

### Seller forms

- **New listing.** Photos are queued on the device, with previews. They upload one at a time after the listing is saved, and the button shows progress. If any upload fails, the seller is taken to the edit page with a notice saying how many photos didn't upload.
- **Editing a listing.** Each add, remove or make-main change is sent straight away. The form only shows what the server confirmed. Failed uploads can be retried or discarded. Leaving the page while an upload is in progress asks for confirmation.

## Pickup and delivery

### Seller options

Each listing has these options:

```
fulfillment: {
  pickup:   { enabled, instructions },
  delivery: { enabled, areas, timing, instructions }
}
```

- **Default.** Pickup is on and delivery is off.
- **Validation.** At least one method must be enabled. Delivery areas are required while delivery is on. Instructions can be up to 300 characters, areas 3–200, and timing up to 120. Unknown fields and wrong types are rejected.
- **Editing.** An edit replaces the whole `fulfillment` object.
- **Out of scope.** "Delivery" means the seller arranges it themselves. There are no couriers, maps, addresses, distance pricing or tracking.

### Ordering

- **Choosing a method.** The product page shows the methods the listing offers. The order form asks the buyer to pick one, and preselects it only when there is just one. Multi-product orders can only use a method every product offers (`sharedFulfillmentMethods`).
- **Server checks.** `POST /api/orders` requires `fulfillmentMethod` (`"pickup"` or `"delivery"`) and checks it against each listing as it is stored at that moment.
  - The method isn't offered: 409, with `fieldErrors.fulfillmentMethod`.
  - The seller changed the options after the order was read but before stock was reserved: 409 with "The seller changed their pickup or delivery options while you were ordering…". This is caught by the stock-reservation filter inside the transaction.
- **Idempotency.** The method is part of the idempotency request hash, so reusing a key with a different method returns 409.
- **Delivery note.** The buyer's note is kept as before.

### Order snapshot

- **What is stored.** Each order stores `fulfillment: { method, details: [{ productId, name, areas, timing, instructions }] }`. This is a copy of what the seller offered when the order was placed. Later edits to the listing don't change it. Buyers and sellers see it on the order page under "Pickup & delivery".
- **Legacy data.** Orders placed before this milestone have no snapshot. The API returns `fulfillment: null` and the page shows fallback text. Listings saved before this milestone have no `fulfillment` field and are treated as pickup only with no instructions. Defaults are applied when the data is read, so **no migration is needed**.
- **Delivery is not shipping.** Choosing delivery doesn't mark anything as shipped. The existing accept → ship → deliver steps are unchanged.

### Money

Choosing pickup or delivery doesn't change any amount:

- `totalKobo` is still equal to `subtotalKobo`.
- The Paystack checkout amount, the ledger entries, the commission, refunds, payouts and settlement are all unchanged. This is covered by tests in `tests/fulfillment.test.ts`.
- Buyers and sellers are told: "Farm Korret doesn't calculate or collect delivery fees. Any delivery charge is agreed directly between you and the seller."

**Business decision needed.** Charging delivery fees through the platform would need its own design and approval (pricing, ledger treatment, refunds). It is deliberately not part of this milestone.

## Configuration

- No new environment variables. The existing `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` (or `CLOUDINARY_URL`) are reused, and so is the optional `CLOUDINARY_FOLDER`.
- No migration is needed.

## Testing

- `tests/product-media.test.ts` and `tests/fulfillment.test.ts` use a fake Cloudinary and a fake Paystack (`tests/support/`) and an in-memory MongoDB. Nothing calls a live service.
- **Needs live testing before release:**
  - real Cloudinary uploads and deletes, and delivery of the `c_limit` transformation URLs;
  - photo picking and upload progress on real phones (camera images, slow networks);
  - a Paystack test-mode checkout for a delivery order, to confirm the amount shown equals the subtotal.
