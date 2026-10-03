export class SecretVault {
  private readonly values: string[] = [];

  note(value: string | undefined | null): void {
    if (!value || value.length < 6) return;
    if (!this.values.includes(value)) this.values.push(value);
  }

  redact(text: string): string {
    let out = text;
    const secrets = [...this.values].sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join("[sekret]");
    }
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [sekret]");
    out = out.replace(
      /\b(password|passwd|token|api[_-]?key)\s*[=:]\s*\S+/gi,
      "$1=[sekret]",
    );
    if (out.length > 400) out = out.slice(0, 400) + "…";
    return out;
  }
}
