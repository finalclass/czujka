# Instrukcje dla agenta implementującego

## Cel i źródła

Zaimplementuj produkt opisany w [README.md](README.md), korzystając z
[IMPLEMENTATION.md](IMPLEMENTATION.md). Repo startuje od dokumentacji; nie
traktuj przykładowych poleceń jako istniejącej implementacji.

Na środowisku właściciela przeczytaj także `/home/sel/.codex/AGENTS.md`, jeżeli
plik istnieje. Kanoniczny checkout tego projektu to `/home/sel/czujka`.

## Workflow i skille

Do decyzji o granicach modułów stosuj skill
[`idesign-architecture`](../.codex/skills/idesign-architecture/SKILL.md), jeśli
jest dostępny lokalnie. Przeczytaj jego SKILL.md i wymagane odnośniki przed
zastosowaniem. Ten link jest lokalny; nie jest zależnością publicznego repo.
Brak prywatnych skilli na innej maszynie nie blokuje pracy według tych
dokumentów.

Przy dostępie do prawdziwych usług na Archea przeczytaj odpowiednio lokalne
skille `forgejo`, `zoho-mail`, `zulip` oraz `secrets` w
`~/.codex/skills/<nazwa>/SKILL.md`. Nie kopiuj ich prywatnej konfiguracji do
repo.

Zlecenie implementacji upoważnia do kodu i testów według tych dokumentów. Nie
dokładaj osobnej bramki zatwierdzania dokumentacji ani obowiązkowego panelu.
Rutynowe wybory implementacyjne podejmuj samodzielnie; istotną sprzeczność
wymagań zgłoś konkretnie. Zmiany w `../operators` wymagają osobnego zakresu
prac.

## Technologia i weryfikacja

- Nowy kod, skrypty i automatyzacje pisz w TypeScript dla Deno.
- CLI pozostaje cienkie. Reguły obserwacji, zapis i integracje mają oddzielne
  granice zgodnie z instrukcją implementacji.
- Dodaj zadania `deno task check` i `deno task test`; sprawdzaj także
  `deno fmt --check` oraz `deno lint`.
- Testy automatyczne używają fałszywego zegara, źródeł i celu wybudzania. Nie
  wymagają kont, nie wysyłają maili i nie budzą rzeczywistych sesji.
- E2E na prawdziwych usługach wykonuj wyłącznie z wyraźnie wskazanymi celami
  testowymi. Samo zlecenie implementacji nie wybiera takiej sesji za
  użytkownika.
- Po implementacji zaktualizuj status README i dodaj sprawdzone instrukcje
  instalacji, konfiguracji oraz uruchomienia usługi użytkownika.
- Podaj wykonane komendy kontroli, wynik i ewentualne niezweryfikowane
  integracje.

## Publiczne repozytorium

Nie commituj sekretów, `.env`, baz, logów, treści maili, eksportów wiadomości,
identyfikatorów rzeczywistych sesji ani plików stanu T3. Przykłady używają
placeholderów. Nie kopiuj prywatnego projektu `operators` do publicznego repo;
sprawdź możliwość ponownego użycia jego kodu i preferuj izolowaną integrację.
