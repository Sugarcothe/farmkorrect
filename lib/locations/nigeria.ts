// The 36 states and the Federal Capital Territory: the one list every form,
// filter and query uses. `value` is what's stored and put in URLs.

export const NIGERIAN_STATES = [
  { value: "abia", label: "Abia" },
  { value: "adamawa", label: "Adamawa" },
  { value: "akwa-ibom", label: "Akwa Ibom" },
  { value: "anambra", label: "Anambra" },
  { value: "bauchi", label: "Bauchi" },
  { value: "bayelsa", label: "Bayelsa" },
  { value: "benue", label: "Benue" },
  { value: "borno", label: "Borno" },
  { value: "cross-river", label: "Cross River" },
  { value: "delta", label: "Delta" },
  { value: "ebonyi", label: "Ebonyi" },
  { value: "edo", label: "Edo" },
  { value: "ekiti", label: "Ekiti" },
  { value: "enugu", label: "Enugu" },
  { value: "fct", label: "FCT (Abuja)" },
  { value: "gombe", label: "Gombe" },
  { value: "imo", label: "Imo" },
  { value: "jigawa", label: "Jigawa" },
  { value: "kaduna", label: "Kaduna" },
  { value: "kano", label: "Kano" },
  { value: "katsina", label: "Katsina" },
  { value: "kebbi", label: "Kebbi" },
  { value: "kogi", label: "Kogi" },
  { value: "kwara", label: "Kwara" },
  { value: "lagos", label: "Lagos" },
  { value: "nasarawa", label: "Nasarawa" },
  { value: "niger", label: "Niger" },
  { value: "ogun", label: "Ogun" },
  { value: "ondo", label: "Ondo" },
  { value: "osun", label: "Osun" },
  { value: "oyo", label: "Oyo" },
  { value: "plateau", label: "Plateau" },
  { value: "rivers", label: "Rivers" },
  { value: "sokoto", label: "Sokoto" },
  { value: "taraba", label: "Taraba" },
  { value: "yobe", label: "Yobe" },
  { value: "zamfara", label: "Zamfara" },
] as const;

export type NigerianState = (typeof NIGERIAN_STATES)[number]["value"];

export const isNigerianState = (value: unknown): value is NigerianState =>
  typeof value === "string" && NIGERIAN_STATES.some((s) => s.value === value);

export const stateLabel = (value: NigerianState) => NIGERIAN_STATES.find((s) => s.value === value)?.label ?? "";

const ALIASES: Record<string, NigerianState> = { abuja: "fct", "federal capital territory": "fct" };

/**
 * A state from a URL or form value: its stored value ("akwa-ibom") or its
 * name in any case ("Akwa Ibom", "AKWA-IBOM"). Anything else is null; nothing
 * is guessed from a partial name or an address.
 */
export function parseNigerianState(value: unknown): NigerianState | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, " ");
  if (ALIASES[key]) return ALIASES[key];
  const slug = key.replace(/ /g, "-");
  const match = NIGERIAN_STATES.find((s) => s.value === slug || s.label.toLowerCase() === key);
  return match?.value ?? null;
}
