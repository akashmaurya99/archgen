// perf-budget.ts — documented render budgets shared by perf tests.
//
// RENDER_BUDGET_PER_FLIP: one status flip re-renders the changed node at most
// 2 times (expected exactly 1; headroom covers React Flow's internal measure
// pass under jsdom). Applies to updates on an ALREADY-MOUNTED canvas.
//
// RENDER_BUDGET_ON_REMOUNT: switching features swaps the whole DAG (new store
// + structure key), so every node REMOUNTS; jsdom RF adds init + measure +
// viewport passes on top of the mount render. Applies only to fresh mounts.
export const RENDER_BUDGET_PER_FLIP = 2;
export const RENDER_BUDGET_ON_REMOUNT = 3;
