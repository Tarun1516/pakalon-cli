/**
 * frontend/App.tsx — official frontend entry point.
 *
 * All UI screens and components now live under src/frontend/:
 *   src/frontend/
 *     animations/
 *       LogoAnimated.tsx    — Video ASCII animation (first launch splash)
 *       LogoStatic.tsx      — Static ASCII logo animation (post-login header)
 *     components/
 *       HeaderBar.tsx       — Top bar: logo + username + model + context% + credits
 *       FileChangeSummary.tsx — Bottom bar: session lines added/deleted
 *     screens/
 *       SplashLoginScreen.tsx — First-launch: video logo + 6-digit device code auth
 *       ChatLayout.tsx       — Authenticated shell: HeaderBar + ChatScreen + FileChangeSummary
 *     App.tsx                — This file (re-exports root App)
 *
 * The root orchestration lives in src/app.tsx which imports from this folder.
 */
export { default } from "@/app.js";
