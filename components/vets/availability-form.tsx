"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { NIGERIAN_STATES, isNigerianState } from "@/lib/locations/nigeria";
import { saveAvailability } from "@/lib/vets/api";
import { formatDay, minuteLabel, WEEKDAYS } from "@/lib/vets/schedule";
import type { AvailabilitySettings, DayHours, SlotMinutes } from "@/lib/vets/types";

/** Every half hour of the day, as select options (the server enforces the same grid). */
const TIMES = Array.from({ length: 49 }, (_, i) => ({ value: String(i * 30), label: minuteLabel(i * 30) }));
const DEFAULT_DAY = { start: 8 * 60, end: 17 * 60 };

/**
 * The vet's booking settings. Saving replaces them all; the server
 * validates again and rebuilds the directory entry from what it stored.
 */
export function AvailabilityForm({
  initial,
  initialIssues,
  today,
}: {
  initial: AvailabilitySettings;
  initialIssues: string[];
  today: string;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [issues, setIssues] = useState(initialIssues);
  const [newDate, setNewDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const set = <K extends keyof AvailabilitySettings>(key: K, value: AvailabilitySettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const dayOf = (day: number) => settings.hours.find((h) => h.day === day);
  function setDay(day: number, value: Omit<DayHours, "day"> | null) {
    const rest = settings.hours.filter((h) => h.day !== day);
    set("hours", (value ? [...rest, { day, ...value }] : rest).sort((a, b) => a.day - b.day));
  }

  function addDate() {
    if (!newDate || newDate < today || settings.blockedDates.includes(newDate)) return;
    set("blockedDates", [...settings.blockedDates, newDate].sort());
    setNewDate("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setFieldErrors({});
    const res = await saveAvailability(settings);
    setSaving(false);
    if (!res.ok) {
      setFieldErrors(res.fieldErrors ?? {});
      setMessage({ tone: "error", text: res.error });
      return;
    }
    setSettings(res.data.settings);
    setIssues(res.data.listingIssues);
    setMessage({ tone: "success", text: "Availability saved." });
    router.refresh();
  }

  return (
    <form onSubmit={save} noValidate className="space-y-5">
      {issues.length > 0 ? (
        <FormAlert tone="error">
          <span className="block font-medium">You aren&rsquo;t shown in Find a Vet yet:</span>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </FormAlert>
      ) : (
        <FormAlert tone="success">You&rsquo;re listed in Find a Vet.</FormAlert>
      )}

      <Switch
        label="Show me in Find a Vet"
        description="Customers can find you and request visits for your bookable services."
        checked={settings.listed}
        onChange={(v) => set("listed", v)}
      />
      {fieldErrors.listed && <p className="text-xs font-medium text-red-600">{fieldErrors.listed}</p>}

      <SelectField
        name="state"
        label="State you work in"
        placeholder="Choose a state"
        options={NIGERIAN_STATES.map((s) => ({ value: s.value, label: s.label }))}
        value={settings.state ?? ""}
        onChange={(e) => set("state", isNigerianState(e.target.value) ? e.target.value : null)}
        error={fieldErrors.state}
      />
      <TextField
        name="area"
        label="Area you cover (optional)"
        placeholder="For example, Ibadan and nearby towns"
        maxLength={60}
        value={settings.area}
        onChange={(e) => set("area", e.target.value)}
        error={fieldErrors.area}
      />

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold">Working hours (Lagos time)</legend>
        {fieldErrors.hours && <p className="text-xs font-medium text-red-600">{fieldErrors.hours}</p>}
        {WEEKDAYS.map((name, day) => {
          const h = dayOf(day);
          return (
            <div key={name} className="rounded-2xl bg-white p-3 ring-1 ring-foreground/8">
              <Switch label={name} checked={Boolean(h)} onChange={(on) => setDay(day, on ? DEFAULT_DAY : null)} />
              {h && (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <SelectField
                    name={`start-${day}`}
                    label="From"
                    placeholder="Start"
                    options={TIMES.slice(0, -1)}
                    value={String(h.start)}
                    onChange={(e) => setDay(day, { start: Number(e.target.value), end: h.end })}
                  />
                  <SelectField
                    name={`end-${day}`}
                    label="Until"
                    placeholder="End"
                    options={TIMES.slice(1)}
                    value={String(h.end)}
                    onChange={(e) => setDay(day, { start: h.start, end: Number(e.target.value) })}
                    error={h.end <= h.start ? "Pick a time after the start." : undefined}
                  />
                </div>
              )}
            </div>
          );
        })}
      </fieldset>

      <SelectField
        name="slotMinutes"
        label="Booking times start every"
        placeholder="Choose an interval"
        options={[
          { value: "30", label: "30 minutes" },
          { value: "60", label: "60 minutes" },
        ]}
        value={String(settings.slotMinutes)}
        onChange={(e) => set("slotMinutes", Number(e.target.value) as SlotMinutes)}
        error={fieldErrors.slotMinutes}
      />

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">Days off</legend>
        {fieldErrors.blockedDates && <p className="text-xs font-medium text-red-600">{fieldErrors.blockedDates}</p>}
        <div className="flex items-end gap-2">
          <TextField
            name="blockedDate"
            label="Add a day"
            type="date"
            min={today}
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="flex-1"
          />
          <Button type="button" variant="outline" className="w-auto px-4" onClick={addDate} disabled={!newDate}>
            Add
          </Button>
        </div>
        {settings.blockedDates.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Days off">
            {settings.blockedDates.map((d) => (
              <li key={d}>
                <button
                  type="button"
                  onClick={() => set("blockedDates", settings.blockedDates.filter((x) => x !== d))}
                  aria-label={`Remove ${formatDay(d)}`}
                  className="flex items-center gap-1 rounded-full bg-primary/8 px-3 py-1.5 text-xs font-medium text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {formatDay(d)}
                  <Icon name="x" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <Switch
        label="Share my phone number with customers"
        description="Only on appointments you've accepted, until the visit ends."
        checked={settings.sharePhoneWithClients}
        onChange={(v) => set("sharePhoneWithClients", v)}
      />

      {message && <FormAlert tone={message.tone}>{message.text}</FormAlert>}
      <p className="text-xs text-muted-foreground">
        Changing your hours doesn&rsquo;t move or cancel appointments that are already booked.
      </p>
      <Button type="submit" loading={saving}>
        Save availability
      </Button>
    </form>
  );
}
