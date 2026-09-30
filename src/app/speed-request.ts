/**
 * Rozhodnutie o rýchlosti pre „pauza/obnova“ — zdieľané medzi HUD (klik na ⏸) a klávesnicou (`Space`,
 * `InputController`), aby obe cesty správali rovnako a logika nebola napísaná dvakrát.
 */

/**
 * Rýchlosť, ktorú má požiadavka odoslať: požiadavka na pauzu (`0`), keď hra už stojí, hru obnoví poslednou nenulovou
 * rýchlosťou (prototyp: ⏸ prepína ⏸ ↔ ▶); inak platí to, čo hráč vybral.
 *
 * @param requested rýchlosť, o ktorú hráč požiadal (0 = pauza)
 * @param current aktuálna rýchlosť sveta
 * @param resumeSpeed posledná nenulová rýchlosť (`undefined` = nie je kam obnoviť)
 */
export function resolveSpeedRequest(requested: number, current: number, resumeSpeed: number | undefined): number {
  return requested === 0 && current === 0 && resumeSpeed !== undefined ? resumeSpeed : requested;
}
