/** Recovery may use canonical inputs only after this attempt wrote its full snapshot. */
export class AppPublishFailure extends Error {
  constructor(message: string, readonly filesMaterialized: boolean) {
    super(message)
    this.name = 'AppPublishFailure'
  }
}
