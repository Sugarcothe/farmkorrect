// Field rules shared by the bank-details form and the API. Each returns an
// error message, or undefined when the value is valid.

/** Nigerian (NUBAN) account numbers are exactly ten digits. */
export const ACCOUNT_NUMBER_LENGTH = 10;

export function validateAccountNumber(value: string): string | undefined {
  if (!value) return "Enter your 10-digit account number.";
  if (!/^\d+$/.test(value)) return "Account numbers only contain digits.";
  if (value.length !== ACCOUNT_NUMBER_LENGTH) return "Nigerian account numbers (NUBAN) are 10 digits long.";
  return undefined;
}

export function validateBankCode(value: string): string | undefined {
  if (!value) return "Choose your bank.";
  if (!/^[A-Za-z0-9]{2,20}$/.test(value)) return "Choose a bank from the list.";
  return undefined;
}

/** Removes the spaces and dashes people type while copying an account number. */
export function normalizeAccountNumber(value: string): string {
  return value.replace(/[\s-]/g, "");
}

export function maskAccountNumber(last4: string): string {
  return `•••• ${last4}`;
}
