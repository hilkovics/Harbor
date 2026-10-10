// Pomôcky pre testy UI v Node (bez DOM): prehľadávanie stromu React elementov vrátených čistým funkčným komponentom
// (bez hookov) a výber hodnôt z HTML reťazca z `renderToStaticMarkup`.
import { isValidElement, type ReactElement, type ReactNode } from 'react';

/** Všetky elementy stromu (hĺbka do `props.children`), pre ktoré platí `predicate`. Vnorené komponenty sa nerozbaľujú. */
export function findAll(node: ReactNode, predicate: (element: ReactElement) => boolean, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) findAll(child, predicate, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  if (predicate(node)) found.push(node);
  findAll((node.props as { children?: ReactNode }).children, predicate, found);
  return found;
}

/** Props elementu ako slovník (React typuje `props` ako `unknown`). */
export function propsOf(element: ReactElement): Record<string, unknown> {
  return element.props as Record<string, unknown>;
}

/** Text elementu s atribútom `data-field="<name>"` v HTML reťazci (element bez vnorených tagov); `null`, ak chýba. */
export function fieldText(html: string, name: string): string | null {
  const match = new RegExp(`<[^>]*data-field="${name}"[^>]*>([^<]*)</`).exec(html);
  return match === null ? null : (match[1] ?? null);
}
