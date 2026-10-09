export class CatalogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogFormatError";
  }
}
