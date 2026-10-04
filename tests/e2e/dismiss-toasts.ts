import { expect, type Page } from '@playwright/test';

/**
 * Zavrie všetky toasty. Zásobník leží nad mapou, takže toast prekrýva kurzor aj klik na bunku (ghost sa nezobrazí, výber
 * modulu sa nespustí); od F5 pool ponúk ohlási „Nové ponuky kontraktov“ hneď na štarte a pri každej uzávierke dňa.
 * Zavretie ostatných toastov nevadí: specy ich nekontrolujú.
 *
 * Tlačidlá × sa klikajú v stránke (`HTMLElement.click()`), nie cez `locator.click({ timeout })`. Toast sa zatvára aj sám
 * (8 s od zobrazenia), takže sa pokus o zavretie môže minúť so zánikom prvku a klik s krátkym limitom sa potom preruší
 * uprostred akcie. Prerušený `locator.click` v Playwrighte (1.56) nechá v stránke nainštalovaný zachytávač cieľa kliku
 * (hit-target interceptor, poslucháč na `window` vo fáze capture) a ten potom spolkne každé ďalšie `pointerdown`,
 * `pointerup` a `click` z `page.mouse` (`stopImmediatePropagation`), kým ho nezruší nejaká úspešná akcia locatora. Hra
 * taký klik nikdy nedostane: InputController ostane v `idle` a `elementFromPoint` ukazuje canvas, hoci sa „klik na mapu“
 * zjavne stal. Tak vznikalo občasné zlyhanie výberu modulu klikom v f2, f4 a f6a. Klik v DOM nemá čo prerušiť a React ho
 * spracuje rovnako (`onClick`); zásobník sa po zavretí viditeľných toastov doplní čakajúcimi, preto sa kroky opakujú, kým
 * nie je prázdny.
 */
export async function dismissToasts(page: Page): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => {
      for (const close of document.querySelectorAll<HTMLElement>('.toasts .toast [data-action="close"]')) close.click();
    });
    await expect(page.locator('.toasts .toast')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
