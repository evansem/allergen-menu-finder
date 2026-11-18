/** An error whose message is safe to show to the person running the tool. */
export class UserError extends Error {
  override name = "UserError";
}
