<?php
// Sync: zet opgeslagen games naar GitHub, zodat de app ze daarvandaan kan laden
// zonder RAWG-API-calls. Draai in een kloon van de gamekast-repo:
//   php sync.php
// De app schrijft via gamekast.php in games/; dit script commit en pusht die map
// en bouwt games/index.json (game-id => mapnaam) voor snel opzoeken.

if (!is_dir(__DIR__ . '/.git')) {
    exit("Dit is geen git-repository. Kloon de gamekast-repo en draai dit script daarin.\n");
}
if (!is_dir(__DIR__ . '/games')) {
    exit("Nog geen games opgeslagen. Like eerst een game in de app.\n");
}

$index = [];
foreach (glob(__DIR__ . '/games/*', GLOB_ONLYDIR) as $dir) {
    $f = $dir . '/info.json';
    if (!is_file($f)) continue;
    $d = json_decode((string)file_get_contents($f), true);
    if (!empty($d['id'])) $index[(string)$d['id']] = basename($dir);
}
file_put_contents(__DIR__ . '/games/index.json',
    json_encode($index, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");

exec('git add -A games/', $o, $code);
if ($code !== 0) exit("git add mislukt. Staat git goed ingesteld in deze map?\n");

exec('git diff --cached --quiet', $o, $clean);
if ($clean === 0) exit("Niets nieuws om te pushen.\n");

passthru('git commit -m "Games bijgewerkt via sync.php"', $code);
if ($code !== 0) exit("Commit mislukt.\n");

passthru('git pull --rebase && git push', $code);
exit($code === 0 ? "Klaar: " . count($index) . " game(s) staan op GitHub.\n" : "Pushen mislukt. Check je internetverbinding en rechten.\n");
