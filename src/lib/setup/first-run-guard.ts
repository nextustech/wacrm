import { redirect } from "@tanstack/react-router";
import { getSetupStatus } from "./setup.functions";

/**
 * First-run gate for the application surfaces.
 *
 * A fresh deployment points at an empty database, where nobody holds the
 * `superadmin` role — so the platform is unusable. The setup wizard that fixes
 * this already existed, but nothing ever navigated to it, so an operator had to
 * already know the URL. This guard makes it unavoidable on the way into the app.
 *
 * Marketing, legal, docs and the other public surfaces are deliberately NOT
 * gated: a half-installed server should still show its landing page.
 *
 * The gate asks "is setup complete", with one deliberate exception: `/auth`
 * only needs a super admin to exist, because signing in is itself a step of
 * finishing setup. An install that gained its admin outside the wizard counts
 * as complete — `readSetupStatus` decides that from the admin's age, so a
 * working deployment is never herded back through the wizard.
 */

/**
 * Setup is one-way, so a positive answer is cached for the lifetime of the
 * tab/process and later navigations cost nothing. A negative answer is never
 * cached — the wizard has to be able to release the gate the moment it creates
 * the admin.
 */
let setupConfirmed = false;

type InstallState = Awaited<ReturnType<typeof getSetupStatus>> | null;

/**
 * `null` means "unknown": the database was momentarily unreachable, or the
 * status could not be read. Every caller treats that as "carry on" — failing
 * closed would throw real users into the wizard over a blip. A *missing
 * schema* is not unknown; `readSetupStatus` reports that as
 * `databaseReady: false`.
 */
async function readInstallState(): Promise<InstallState> {
  if (setupConfirmed) {
    return { superAdminExists: true, setupComplete: true, completedAt: null, databaseReady: true };
  }
  try {
    const status = await getSetupStatus();
    if (status.setupComplete) setupConfirmed = true;
    return status;
  } catch {
    return null;
  }
}

/**
 * Guards the application itself: the installation must be finished.
 *
 * Note which question this asks. "A super admin exists" is enough to let
 * somebody sign in, but it is not enough to run the app on: a wizard abandoned
 * after step 2 leaves branding, localization, SMTP and the SaaS settings at
 * their defaults, and nothing would ever bring the operator back to finish.
 * Migration 20261105160000 backfills `setup_complete` for installations that
 * got their admin outside the wizard, so this stricter rule cannot lock anyone
 * out of a deployment that was already working.
 */
export async function requireInstalledApp(): Promise<void> {
  const state = await readInstallState();
  if (!state) return;
  if (!state.databaseReady || !state.setupComplete) throw redirect({ to: "/setup" });
}

/**
 * Guards `/auth`. Signing in is part of *finishing* setup — the wizard asks
 * the operator to sign in as the admin it just created — so this one only
 * requires that an admin exists. Gating it on `setupComplete` would deadlock:
 * the wizard would send the operator to `/auth` and `/auth` straight back.
 */
export async function requireAuthEntry(): Promise<void> {
  const state = await readInstallState();
  if (!state) return;
  if (!state.databaseReady || !state.superAdminExists) throw redirect({ to: "/setup" });
}

/**
 * Public surfaces of an uninstalled deployment.
 *
 * The marketing site, the legal pages and the docs must keep working on a
 * server that has only just been unpacked — they sell and explain the product,
 * and they touch nothing. The wizard itself obviously has to stay reachable,
 * and `/api` routes answer machines, not people. Everything else — `/auth`,
 * password reset, invites, the store, payment links, the app itself — is part
 * of a working installation and stays closed until there is one.
 */
const PUBLIC_WHEN_UNINSTALLED = [
  "/setup",
  "/install",
  "/install-app",
  "/api/",
  "/docs",
  "/legal",
  "/privacy",
  "/terms",
  "/pricing",
  "/features",
  "/about",
  "/contact",
  "/maintenance",
  "/offline",
  "/403",
  "/sitemap.xml",
  "/robots.txt",
];

/** True for the landing page and the other surfaces listed above. */
function isPublicPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return true;
  return PUBLIC_WHEN_UNINSTALLED.some(
    (p) => path === p || path.startsWith(`${p}/`) || path.startsWith(p),
  );
}

/** `/auth` and the paths that only exist to get somebody onto `/auth`. */
function isSignInPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/auth" || path === "/forgot-password" || path === "/reset-password";
}

/**
 * Root-route gate. Every route that is not a public marketing surface is
 * unreachable until the installation is finished, so an operator cannot land
 * on a sign-in form, an invite link or a deep link into the app and be left
 * wondering why nothing works. Attached to the root route rather than to
 * individual routes so a new route is gated by default.
 *
 * Three states, not two:
 *   - no schema, or no super admin  → everything goes to the wizard
 *   - admin exists, setup unfinished → only `/auth` opens, so the operator can
 *     sign in and the wizard can verify them; the app itself still waits
 *   - setup complete                 → nothing is gated, and `/setup` closes
 */
export async function guardAppEntry(pathname: string): Promise<void> {
  if (isPublicPath(pathname)) return;
  if (isSignInPath(pathname)) {
    await requireAuthEntry();
    return;
  }
  await requireInstalledApp();
}

/**
 * True once this tab has bootstrapped the first admin through a wizard.
 *
 * Creating the admin makes `superAdminExists` true, and signing it in fires
 * `router.invalidate()` — which re-runs the wizard's own `beforeLoad` while the
 * operator is still on step 2 of 6. Without this flag the closed-installation
 * rule below would eject them from the wizard they are in the middle of.
 * In-memory on purpose: a reload re-locks the wizard, which is the safe default.
 */
let wizardOwnsThisSession = false;

export function markWizardBootstrappedAdmin(): void {
  wizardOwnsThisSession = true;
}

export type InstallerAccess = {
  /** An admin already existed when the wizard opened (so it is a re-visit). */
  existingSuperAdmin: boolean;
  /** Set when setup status could not be read; the wizard surfaces it. */
  setupStatusError: string | null;
  /** The signed-in super admin, when one was required and verified. */
  userId: string | null;
};

/**
 * Guards `/setup` and `/install`.
 *
 * An installed app must never be able to re-enter a wizard: the later steps
 * overwrite branding, localization, SMTP and SaaS settings wholesale, and
 * `/install` can re-run the one-click installer. So the wizard opens only for a
 * genuinely fresh database — or for the session that is part-way through
 * setting one up.
 *
 * `setup_complete` alone is not enough to lock it: installs that got their
 * admin outside the wizard never set that flag, and were left wide open.
 */
export async function requireOpenInstaller(from: "/setup" | "/install"): Promise<InstallerAccess> {
  let status: Awaited<ReturnType<typeof getSetupStatus>>;
  try {
    status = await getSetupStatus();
  } catch (error) {
    return {
      existingSuperAdmin: false,
      setupStatusError: error instanceof Error ? error.message : "Could not check setup status",
      userId: null,
    };
  }

  if (status.setupComplete) throw redirect({ to: "/auth" });

  if (!status.databaseReady) {
    // The wizard cannot create an admin into a database that has no tables,
    // so say so on step 1 instead of failing on the create-account button.
    return {
      existingSuperAdmin: false,
      setupStatusError:
        "This database has no WACRM schema yet. Run the migrations (`supabase db push`) against it, then reload this page.",
      userId: null,
    };
  }

  if (!status.superAdminExists) {
    return { existingSuperAdmin: false, setupStatusError: null, userId: null };
  }

  // An admin exists but setup is unfinished — an abandoned wizard, or an admin
  // created outside it. The run has to be resumable, otherwise the app gate
  // (which now wants `setup_complete`) and this one bounce the operator back
  // and forth forever. Resuming is safe: nothing is configured yet to destroy.
  //
  // The tab that just created the admin is let through without a session
  // check, because `router.invalidate()` fires on SIGNED_IN and re-runs this
  // guard in the gap between "user created" and "signed in".
  if (wizardOwnsThisSession) {
    return { existingSuperAdmin: true, setupStatusError: null, userId: null };
  }

  // Any other tab must prove it is the super admin before resuming.
  const { supabase } = await import("@/integrations/supabase/client");
  const { data: sessionResult } = await supabase.auth.getSession();
  const user = sessionResult.session?.user;
  if (!user) throw redirect({ to: "/auth", search: { next: from } });

  const { data: isAdmin, error } = await supabase.rpc("is_super_admin", { _user_id: user.id });
  if (error || !isAdmin) {
    throw redirect({ to: "/403", search: { scope: "platform", required: "superadmin", from } });
  }

  return { existingSuperAdmin: true, setupStatusError: null, userId: user.id };
}
