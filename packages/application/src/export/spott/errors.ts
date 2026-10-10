export class SpottApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SpottApiError";
    this.status = status;
  }
}
