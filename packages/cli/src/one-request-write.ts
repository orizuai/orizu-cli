// The words a one-request CLI write uses when its request was sent but no
// reply came back, so the change may already be saved (ORI-2726, ORI-2719).
export interface MayAlreadyBeSaved {
  readonly mayAlreadyBeSaved: true
  readonly advice: string
}

/** `The <thing> may already be <done>: <advice>.` */
export function mayAlreadyBeSavedLine(thing: string, done: string, advice: string): string {
  return `The ${thing} may already be ${done}: ${advice}.`
}

/** The fields a `--json` failure object gains. */
export function mayAlreadyBeSavedFields(advice: string): MayAlreadyBeSaved {
  return { mayAlreadyBeSaved: true, advice }
}
