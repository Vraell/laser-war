/** Select the terminal detail that matches how a drawn game ended. */
export function drawDetailKey(outcome) {
  return outcome?.hitKings?.size === 2 ? "drawDetail" : "stalemateDetail";
}
