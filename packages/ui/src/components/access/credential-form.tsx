/**
 * Renders the reviewed Access credential catalog in an isolated form. Values
 * exist only in this mounted component and the dedicated vault submission;
 * remote elements cannot inject markup, defaults, links, or submit actions.
 */
import {
  credentialRequestSchema,
  type RemoteCredentialRequest,
} from "access/client";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type Element = RemoteCredentialRequest["spec"]["elements"][string];
type Field = Extract<Element, { type: "SecretField" }>;

function vaultSite(site: string): string | null {
  // Access stores host keys without IPv6 brackets, including an explicit port.
  if (/^[A-Za-z0-9._:-]+$/.test(site)) return site.toLowerCase();
  try {
    const url = new URL(site);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.host.replaceAll(/[[\]]/g, "");
  } catch {
    // error-policy:J3 Invalid site metadata cannot authorize a vault destination.
    return null;
  }
}

/** Reject disconnected, repeated, foreign-ref, or ambiguous forms before entry. */
export function credentialFields(
  request: RemoteCredentialRequest,
  accountSite: string = request.site,
): Field[] | null {
  const parsed = credentialRequestSchema.safeParse(request);
  if (!parsed.success) return null;
  const { spec, refs } = parsed.data;
  const site = vaultSite(accountSite);
  if (
    site === null ||
    vaultSite(request.site) !== site ||
    refs.some((ref) => !ref.startsWith(`vault://${site}/`))
  )
    return null;
  const root = spec.elements[spec.root];
  if (root?.type !== "CredentialRequest" || root.props.site !== request.site)
    return null;
  if (new Set(root.children).size !== root.children.length) return null;
  if (Object.keys(spec.elements).length !== root.children.length + 1)
    return null;
  const fields: Field[] = [];
  let submits = 0;
  for (const [index, id] of root.children.entries()) {
    const element = spec.elements[id];
    if (!element || element.type === "CredentialRequest") return null;
    if (element.type === "SecretField") fields.push(element);
    if (element.type === "Submit") {
      submits += 1;
      if (index !== root.children.length - 1) return null;
    }
  }
  const fieldRefs = new Set(fields.map((field) => field.props.ref));
  if (
    submits !== 1 ||
    fields.length === 0 ||
    fieldRefs.size !== fields.length ||
    new Set(refs).size !== refs.length ||
    refs.length !== fields.length ||
    refs.some((ref) => !fieldRefs.has(ref))
  )
    return null;
  return fields;
}

const labels = {
  username: "Username",
  email: "Email",
  password: "Password",
  code: "Verification code",
  token: "API key",
  text: "Account detail",
} as const;

export interface CredentialFormProps {
  accountSite: string;
  request: RemoteCredentialRequest;
  onSubmit: (values: Readonly<Record<string, string>>) => Promise<void>;
  onCancel: () => void;
}

/** Mount with the request ID as a key so replacement challenges erase old input. */
export function CredentialForm({
  accountSite,
  request,
  onSubmit,
  onCancel,
}: CredentialFormProps) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [expired, setExpired] = useState(request.expiresAt <= Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = request.expiresAt - Date.now();
      if (remaining <= 0) {
        setValues({});
        setExpired(true);
      } else {
        setExpired(false);
        timer = setTimeout(check, Math.min(remaining, 2147483647));
      }
    };
    check();
    return () => clearTimeout(timer);
  }, [request.expiresAt]);
  const fields = credentialFields(request, accountSite);
  if (fields === null)
    return (
      <p role="alert">
        This sign-in form could not be verified. Refresh the connection to
        request a new form.
      </p>
    );
  const codesOnly = fields.every((field) => field.props.kind === "code");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (request.expiresAt <= Date.now()) {
      setValues({});
      setError(
        "This sign-in request expired. Refresh the connection to continue.",
      );
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    const submitted = values;
    setValues({});
    try {
      await onSubmit(submitted);
    } catch {
      // error-policy:J1 Credential transport failures must never echo values or server diagnostics.
      setError(
        "Your sign-in details could not be submitted. Refresh the connection before trying again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="access-credential-form"
      onSubmit={submit}
      autoComplete="off"
      data-private="true"
    >
      <div className="access-section-heading">
        <span aria-hidden="true">↳</span>
        <h3>{codesOnly ? "Verify your account" : "Sign in securely"}</h3>
      </div>
      <p className="access-muted">
        {codesOnly
          ? "This code is used once and expires shortly. It is not saved to your vault."
          : "Your login details go to your private vault. Aiko receives references, never your password."}
      </p>
      {fields.map(({ props }, index) => (
        <div className="access-field" key={props.ref}>
          <Label htmlFor={`${id}-${index}`}>
            {props.label ??
              (props.name
                ? props.name.replaceAll(/[._-]/g, " ")
                : labels[props.kind])}
          </Label>
          <Input
            data-agent-sensitive="true"
            id={`${id}-${index}`}
            type={
              ["password", "token", "code"].includes(props.kind)
                ? "password"
                : props.kind === "email"
                  ? "email"
                  : "text"
            }
            autoComplete={props.kind === "code" ? "one-time-code" : "off"}
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={busy || expired}
            value={values[props.ref] ?? ""}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [props.ref]: event.target.value,
              }))
            }
          />
          {props.kind === "code" && !codesOnly && (
            <small className="access-muted">
              Used once; not saved to your vault.
            </small>
          )}
        </div>
      ))}
      {expired && (
        <p role="alert">
          This sign-in request expired. Refresh the connection to continue.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="access-actions">
        <Button
          type="submit"
          variant="accentDarkHover"
          className="access-primary"
          disabled={busy || expired}
        >
          {busy
            ? "Continuing…"
            : codesOnly
              ? "Verify and continue"
              : "Save and continue"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setValues({});
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
