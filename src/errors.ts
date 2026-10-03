export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/** Drugi demon kończy się tym błędem i kodem 2, żeby systemd nie restartował go w pętli. */
export class AlreadyRunningError extends UserError {
  constructor() {
    super("Demon czujki już działa.");
    this.name = "AlreadyRunningError";
  }
}
