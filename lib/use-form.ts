import { useState } from "react";

type Values = Record<string, string | boolean>;
type Errors<T> = Partial<Record<keyof T, string>>;

/**
 * Minimal form state: errors show once a field is blurred or the form has
 * been submitted, and submit focuses the first invalid field.
 */
export function useForm<T extends Values>(
  initial: T,
  validate: (values: T) => Errors<T>,
) {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof T, boolean>>>(
    {},
  );
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Errors<T>>({});

  const allErrors = validate(values);
  for (const key of Object.keys(serverErrors) as Array<keyof T>) {
    allErrors[key] ??= serverErrors[key];
  }
  const visibleErrors: Errors<T> = {};
  for (const key of Object.keys(allErrors) as Array<keyof T>) {
    if (allErrors[key] && (submitted || touched[key]))
      visibleErrors[key] = allErrors[key];
  }

  function setValue<K extends keyof T>(name: K, value: T[K]) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setServerErrors((prev) => ({ ...prev, [name]: undefined }));
  }

  /** props for a text input bound to `name` */
  function field(name: keyof T & string) {
    return {
      name,
      value: String(values[name]),
      error: visibleErrors[name],
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
      ) => setValue(name, e.target.value as T[typeof name]),
      onBlur: () => setTouched((prev) => ({ ...prev, [name]: true })),
    };
  }

  function handleSubmit(onValid: (values: T) => void) {
    return (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setSubmitted(true);
      const firstInvalid = (Object.keys(allErrors) as string[]).find(
        (key) => allErrors[key as keyof T],
      );
      if (firstInvalid) {
        e.currentTarget
          .querySelector<HTMLElement>(`[name="${firstInvalid}"]`)
          ?.focus();
        return;
      }
      onValid(values);
    };
  }

  return {
    values,
    errors: visibleErrors,
    field,
    setValue,
    setServerErrors,
    handleSubmit,
  };
}
