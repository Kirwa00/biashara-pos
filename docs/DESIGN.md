---
name: Biashara Precision
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#3d4a3f'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#6d7b6e'
  outline-variant: '#bccabc'
  surface-tint: '#006d38'
  primary: '#006d38'
  on-primary: '#ffffff'
  primary-container: '#00a859'
  on-primary-container: '#003317'
  inverse-primary: '#59df89'
  secondary: '#565e74'
  on-secondary: '#ffffff'
  secondary-container: '#dae2fd'
  on-secondary-container: '#5c647a'
  tertiary: '#904d00'
  on-tertiary: '#ffffff'
  tertiary-container: '#db790a'
  on-tertiary-container: '#452200'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#77fca3'
  primary-fixed-dim: '#59df89'
  on-primary-fixed: '#00210d'
  on-primary-fixed-variant: '#005228'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#ffdcc3'
  tertiary-fixed-dim: '#ffb77d'
  on-tertiary-fixed: '#2f1500'
  on-tertiary-fixed-variant: '#6e3900'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  display-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  financial-xl:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.02em
  financial-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  label-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.04em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-desktop: 1.5rem
  margin: 0.75rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style

This design system is engineered for high-velocity retail, wholesale, and hospitality operations across East Africa. It serves shopkeepers, cashiers, accountants, and SME directors who need split-second clarity under intense counter pressure and fluctuating network environments. 

The aesthetic is Modern Functional Fintech: sharp, legible, high-contrast, and deeply utilitarian without feeling sterile. It blends the structural discipline of enterprise financial tooling with the immediate, thumb-friendly speed required by modern mobile and touch POS terminals.

The emotional signature is operational confidence, absolute transaction transparency, and financial momentum. Interfaces prioritize rapid numerical processing, unambiguous peripheral feedback, and clear transaction states (e.g., instant MPESA validation and automated eTIMS fiscal compliance).

## Colors

The palette balances infrastructural authority with active financial execution:

- **Primary (`#00A859` / Active `#008746`):** Safaricom Emerald Green anchors all primary transaction pathways, success confirmations, valid balances, and positive cash flow metrics.
- **Secondary (`#0F172A`):** Deep Navy Slate serves as the operational spine—powering headers, high-level navigation chrome, core product IDs, and definitive balance ledgers.
- **Tertiary (`#D97706`):** Warm Amber commands attention for non-fatal operational friction: STK Push pending responses, overdue credit customer ledgers, and eTIMS offline queue states.
- **Critical Alert (`#EF4444`):** High-saturation Coral Red is strictly reserved for failed transactions, zero-stock lockouts, voided receipts, and critical hardware disconnection.
- **Neutral Core:** Backdrops rely on ultra-clean Cool Gray (`#F8FAFC`), structured container cards sit on absolute white (`#FFFFFF`), and structural dividers use subtle slate borders (`#E2E8F0`). Secondary data labels utilize Slate 500 (`#64748B`).

Color is never purely decorative; every chromatic element serves as an instant status indicator to minimize cashier cognitive load.

## Typography

Typography enforces strict functional separation between contextual navigation and numerical execution:

- **Headlines & Display:** Set in **Plus Jakarta Sans** to introduce geometric structure, modern authority, and welcoming clarity across dashboard headers and modal summaries.
- **Body & Numerical Ledgers:** Set in **Inter** to ensure maximum readability under sub-optimal ambient light and screen glare.
- **Financial & Data Display Rules:** All monetary totals (KSh), stock counts, barcode sequences, and tax breakdowns require tabular lining figures (`font-variant-numeric: tabular-nums lining-nums`). Decimal cents must be visually separated or slightly subdued to prevent cashier checkout errors.
- **Status & Meta Labels:** Rendered in uppercase with slight tracking (`letterSpacing: 0.04em`) at 11px to 13px for rapid badge recognition across table rows.

## Layout & Spacing

The layout model is driven by dense productivity needs and ergonomic touch targets:

- **Split Workspace Architecture:** For countertop POS devices (tablets and dual-screen terminals), enforce a persistent split layout: 60% fluid product grid / barcode scanning canvas on the left, paired with a fixed 40% (minimum 380px) checkout/cart slip on the right.
- **Touch Ergonomics:** Interactive cashier elements (tender buttons, numeric keypads, quantity incrementors) must maintain a minimum bounding box of 48px × 48px to eliminate mis-taps during rush hours.
- **Responsive Adaptations:**
  - **Mobile (Handheld POS / Smartphones):** Single-column layout. Cart collapses into a persistent high-contrast bottom bar displaying total KSh amount and a direct one-tap "Charge" action.
  - **Tablet & POS Terminal (768px – 1199px):** Split grid with compact gutters (`1rem`) to maximize visible product inventory without vertical scroll.
  - **Desktop Back-Office (1200px+):** Fluid 12-column layout with 24px gutters, fixed left utility rail, and multi-column ledger tables for inventory management, tax reports, and ledger audits.

## Elevation & Depth

Visual hierarchy prioritizes precision edge definition over cinematic depth:

- **Base Layer:** Crisp `#F8FAFC` foundation.
- **Structural Elevation:** Cards, inventory tiles, and data tables rely primarily on 1px crisp borders (`#E2E8F0`) with zero shadow at baseline, preserving clarity on high-traffic, low-cost LCD displays.
- **Contextual Elevation (Cards & Panels):** Interactive elements utilize an ambient, ultra-subtle slate drop shadow: `0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)`.
- **Active Modals & Tender Sheets:** Floating checkout prompts, customer lookups, and cash drawer tenders use an elevated overlay: `0 12px 24px -4px rgba(15, 23, 42, 0.12), 0 4px 6px -2px rgba(15, 23, 42, 0.04)` combined with a 40% Navy Slate backdrop mask (`rgba(15, 23, 42, 0.4)`).
- **Physical Feedback (Keypads & Triggers):** Buttons utilize a tactile inner active border and instant 1px downward shift (`transform: translateY(1px)`) to provide definitive feedback on resistive or capacitive touch surfaces.

## Shapes

The design system adopts a **Soft (Level 1)** corner geometry (`0.25rem` / 4px base radius) across interactive elements. 

- Form inputs, action triggers, tabular cell selections, and numeric keypad items use `4px` corner radii to maximize printable visual space and maintain rigid grid alignment.
- Container panels, checkout slips, and receipt modals scale slightly to `8px` (`0.5rem`) for subtle structural framing.
- Status indicator pills and verification badges remain the sole exception, utilizing full pill radii (`9999px`) to create clear shape differentiation between executable actions and static metadata.

## Components

### Buttons & Quick Tenders
- **Primary Transaction Action:** Emerald background (`#00A859`), pure white text, 48px minimum height. High visual dominance. Active state transitions to `#008746`.
- **Secondary / Utility Action:** Navy slate background (`#0F172A`) or clean bordered slate (`1px solid #CBD5E1`), optimized for receipt printing, quotation holds, and item notes.
- **Numeric Keypad Keys:** Surface white with `#E2E8F0` border, `financial-xl` typography, high-contrast tap states.

### Status Badges & Fiscal Chips
Pill-shaped, uppercase labels with a 6px status dot indicator:
- **eTIMS Synced:** Soft emerald tint (`#ECFDF5`), deep emerald text (`#065F46`), vibrant green dot.
- **STK Pending:** Soft amber tint (`#FFFBEB`), amber text (`#92400E`), pulsing yellow/amber dot.
- **Overdue / Debt:** Soft rose tint (`#FEF2F2`), deep crimson text (`#991B1B`), solid red dot.
- **Low Stock:** Soft orange-amber tint (`#FFF7ED`), deep orange text (`#9A3412`).

### Data Tables & Ledger Grids
- **Header:** Sticky top, light slate background (`#F1F5F9`), uppercase 11px Inter tracking, 36px height.
- **Row Heights:** 44px for compact inventory lists; 56px for ledger items featuring dual line metadata (e.g., Product Name + SKU/Barcode).
- **Alignment:** Text fields align left; status badges align center; financial figures (KSh amounts, quantities, tax totals) strictly align right with tabular numerals.
- **Dividers:** 1px horizontal lines (`#F1F5F9`). Alternate row striping is omitted in favor of active hover/tap state highlights (`#F8FAFC`).

### Input Fields & Search Bars
- **Barcode & SKU Search:** High-visibility text input with an integrated barcode scanner trigger icon, 48px height, 1px border (`#CBD5E1`), focusing to a 2px emerald ring (`#00A859`).
- **Tender Inputs:** Large financial entry display with fixed "KSh" currency prefix, right-aligned bold numerals (`financial-xl`), enabling immediate cross-counter visibility.

### Inventory Tiles (POS Screen)
- Compact cards featuring fixed top-half product image or fallback two-letter category avatar.
- Bottom half hosts bold product title (2-line clamp maximum), stock counter pill at top right, and high-visibility price tag at bottom left.
- Disabled state immediately greys out card with a centered "OUT OF STOCK" red badge when physical inventory hits zero.

### Sliding Receipt Drawer / Cart Summary
- Persistent right pane featuring itemized listings with instant swipe-to-delete or inline stepper controls (`+` / `-`).
- Fixed bottom dock displaying Tax Breakdown (16% VAT), Net Total, and full-width split-tender action buttons (Cash, M-PESA, Card, Credit).