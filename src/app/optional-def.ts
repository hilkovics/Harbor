/**
 * Voliteľné číselné pole defu (F6a, T6A-07): defy exportu (`economy.cutoffHours`, `ships[*].lashingTicksPerUnit`,
 * `paperworkTicks`) dodáva paralelná karta T6A-02, takže typy `EconomyDef` / `ShipClassDef` ich v tejto vetve ešte
 * nemusia mať. UI ich číta len na odvodenie zobrazovaných hodnôt (odstup cut-off ponuky, celková doba lashingu pre
 * progres); keď def pole nemá, hodnota sa nezobrazí. Po zlúčení s T6A-02 sa čítanie dá nahradiť priamym typovaným
 * prístupom.
 */

/** Konečné číslo ≥ 0 z poľa `key` defu `source`, inak `undefined`. */
export function optionalDefNumber(source: object, key: string): number | undefined {
  const value: unknown = (source as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
