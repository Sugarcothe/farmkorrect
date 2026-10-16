"use client";

import { useState } from "react";
import { FormAlert } from "@/components/auth/auth-screen";
import { Switch } from "@/components/ui/switch";
import { getNotificationPreferences, updateNotificationPreferences } from "@/lib/notifications/api";
import {
  CHANNEL_LABELS,
  EXTERNAL_CHANNELS,
  NOTIFICATION_CATEGORIES,
  type ExternalChannel,
  type NotificationCategory,
  type PreferencesResponse,
} from "@/lib/notifications/types";
import { PushOptIn } from "./push-opt-in";

/**
 * Which channels to use for each kind of notification. Each switch is saved
 * on its own and shows what the server stored; while a change is saving the
 * switch is locked. Account security can't be turned off, and channels that
 * can't reach this account yet are shown off and disabled, with the reason.
 */
export function PreferencesForm({ initial }: { initial: PreferencesResponse }) {
  const [data, setData] = useState(initial);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function change(category: NotificationCategory, channel: ExternalChannel, value: boolean) {
    if (saving) return;
    const key = `${category}.${channel}`;
    setSaving(key);
    setError(null);
    setNotice(null);
    const result = await updateNotificationPreferences({ [category]: { [channel]: value } });
    setSaving(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setData(result.data);
    setNotice("Saved.");
  }

  // after this device's push subscription changes, re-read which channels can reach the account
  async function reload() {
    const result = await getNotificationPreferences();
    if (result.ok) setData(result.data);
  }

  const unavailable = EXTERNAL_CHANNELS.filter((channel) => !data.channels[channel].available);

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Everything always appears in your in-app inbox. Choose where else you&apos;d like to hear about it. Turning a
        channel off never deletes anything from your inbox.
      </p>

      {unavailable.length > 0 && (
        <div className="rounded-2xl bg-foreground/[0.03] px-4 py-3 text-xs leading-relaxed text-muted-foreground ring-1 ring-foreground/5">
          <ul className="space-y-1">
            {unavailable.map((channel) => (
              <li key={channel}>
                <span className="font-medium text-foreground/70">{CHANNEL_LABELS[channel]}:</span>{" "}
                {data.channels[channel].note ?? "Not available yet."}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div aria-live="polite">
        {error && <FormAlert>{error}</FormAlert>}
        {notice && !error && <p className="sr-only">{notice}</p>}
      </div>

      {NOTIFICATION_CATEGORIES.map((category) => {
        const mandatory = data.mandatory.includes(category.value);
        return (
          <section
            key={category.value}
            aria-labelledby={`pref-${category.value}`}
            className="rounded-3xl bg-white px-4 py-4 shadow-sm ring-1 ring-foreground/5"
          >
            <h2 id={`pref-${category.value}`} className="text-sm font-semibold">
              {category.label}
            </h2>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{category.description}</p>
            <div className="mt-3 space-y-3">
              <Switch label={CHANNEL_LABELS.in_app} description="Always on" checked disabled onChange={() => {}} />
              {EXTERNAL_CHANNELS.map((channel) => {
                const available = data.channels[channel].available;
                const checked = available && (mandatory || data.preferences[category.value][channel]);
                return (
                  <Switch
                    key={channel}
                    label={CHANNEL_LABELS[channel]}
                    description={!available ? "Not available yet" : mandatory ? "Required for your security" : undefined}
                    checked={checked}
                    disabled={!available || mandatory || (saving !== null && saving !== `${category.value}.${channel}`)}
                    busy={saving === `${category.value}.${channel}`}
                    onChange={(value) => void change(category.value, channel, value)}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

      <PushOptIn publicKey={data.pushPublicKey} onChanged={() => void reload()} />
    </div>
  );
}
