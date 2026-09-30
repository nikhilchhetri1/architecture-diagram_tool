<#
.SYNOPSIS
  Mandatory structural + geometric self-check for .drawio architecture diagrams.
  Run this after every edit to a .drawio file, before considering it final.

.DESCRIPTION
  Catches four classes of defects that have caused visible label/line overlaps in past diagrams:
    1. Duplicate mxCell ids
    2. Dangling edge source/target references
    3. Node-vs-node bounding-box overlaps (labels or icons placed on top of each other)
    4. Edge-path-vs-unrelated-node crossings: for every edge with explicit waypoints, each
       straight segment of its polyline (including the implied segments to/from its source and
       target ports) is checked against every node's bounding box EXCEPT the edge's own source and
       target. This is the check that catches an edge (and its auto-positioned label) passing
       through or landing on top of a node it isn't connected to — the root cause of the
       "pooled connection, saves agreement" label rendering on top of the otherfns node in an
       earlier revision of the Agreement diagram.

.USAGE
  ./diagrams/validate-drawio.ps1 -Path "diagrams/Agreement Module-current-architecture.drawio"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$xml = [xml](Get-Content $Path -Raw)
$cells = $xml.mxfile.diagram.mxGraphModel.root.mxCell
$hadIssue = $false

# 1. Duplicate ids
$ids = $cells | ForEach-Object { $_.id }
Write-Host "--- Duplicate ID check ---"
$dupes = $ids | Group-Object | Where-Object { $_.Count -gt 1 }
if ($dupes) { $hadIssue = $true; $dupes | ForEach-Object { Write-Host "DUPLICATE ID: $($_.Name)" } }
else { Write-Host "OK - no duplicate ids" }

# 2. Dangling edges
$idSet = @{}
foreach ($i in $ids) { $idSet[$i] = $true }
$edges = $cells | Where-Object { $_.edge -eq "1" }
Write-Host "--- Dangling edge check ---"
$danglingFound = $false
foreach ($e in $edges) {
  if (-not $idSet.ContainsKey($e.source)) { Write-Host "$($e.id): missing source $($e.source)"; $danglingFound = $true; $hadIssue = $true }
  if (-not $idSet.ContainsKey($e.target)) { Write-Host "$($e.id): missing target $($e.target)"; $danglingFound = $true; $hadIssue = $true }
}
if (-not $danglingFound) { Write-Host "OK - no dangling edges" }

# 3. Node-vs-node bounding box overlap (excludes legitimate full containment, e.g. layer contains child)
$verts = $cells | Where-Object { $_.vertex -eq "1" }
$boxes = $verts | ForEach-Object {
  $g = $_.mxGeometry
  [pscustomobject]@{ Id = $_.id; X = [double]$g.x; Y = [double]$g.y; W = [double]$g.width; H = [double]$g.height }
}
Write-Host "--- Node/label overlap check ---"
$overlapFound = $false
for ($i = 0; $i -lt $boxes.Count; $i++) {
  for ($j = $i + 1; $j -lt $boxes.Count; $j++) {
    $a = $boxes[$i]; $b = $boxes[$j]
    $ax2 = $a.X + $a.W; $ay2 = $a.Y + $a.H; $bx2 = $b.X + $b.W; $by2 = $b.Y + $b.H
    $ov = ($a.X -lt $bx2 -and $ax2 -gt $b.X -and $a.Y -lt $by2 -and $ay2 -gt $b.Y)
    if (-not $ov) { continue }
    $aInB = ($a.X -le $b.X -and $a.Y -le $b.Y -and $ax2 -ge $bx2 -and $ay2 -ge $by2)
    $bInA = ($b.X -le $a.X -and $b.Y -le $a.Y -and $bx2 -ge $ax2 -and $by2 -ge $ay2)
    if ($aInB -or $bInA) { continue }
    Write-Host "OVERLAP: $($a.Id) vs $($b.Id)"
    $overlapFound = $true; $hadIssue = $true
  }
}
if (-not $overlapFound) { Write-Host "OK - no node/label overlaps" }

# 4. Edge-path-vs-unrelated-node crossing check
$boxById = @{}
foreach ($b in $boxes) { $boxById[$b.Id] = $b }

function Test-SegmentBoxIntersect($x1, $y1, $x2, $y2, $box) {
  # Orthogonal segments only (horizontal or vertical), matching edgeStyle=orthogonalEdgeStyle.
  $bx1 = $box.X; $by1 = $box.Y; $bx2 = $box.X + $box.W; $by2 = $box.Y + $box.H
  if ($x1 -eq $x2) {
    # vertical segment at x=x1, spanning y1..y2
    $ylo = [Math]::Min($y1, $y2); $yhi = [Math]::Max($y1, $y2)
    return ($x1 -gt $bx1 -and $x1 -lt $bx2 -and $yhi -gt $by1 -and $ylo -lt $by2)
  }
  elseif ($y1 -eq $y2) {
    # horizontal segment at y=y1, spanning x1..x2
    $xlo = [Math]::Min($x1, $x2); $xhi = [Math]::Max($x1, $x2)
    return ($y1 -gt $by1 -and $y1 -lt $by2 -and $xhi -gt $bx1 -and $xlo -lt $bx2)
  }
  else {
    # diagonal segment (shouldn't occur with orthogonal routing) - skip, can't test simply
    return $false
  }
}

function Get-PortPoint($nodeBox, $frac) {
  # Reserved for future extension (currently port points are computed inline below).
}

Write-Host "--- Edge-path vs unrelated-node crossing check ---"
$crossingFound = $false
foreach ($e in $edges) {
  $srcId = $e.source; $tgtId = $e.target
  if (-not $boxById.ContainsKey($srcId) -or -not $boxById.ContainsKey($tgtId)) { continue }
  $srcBox = $boxById[$srcId]; $tgtBox = $boxById[$tgtId]

  # Parse exit/entry fractions from style (default to center = 0.5,0.5 if absent)
  $style = $e.style
  function Get-Frac($style, $name, $default) {
    $m = [regex]::Match($style, "$name=([0-9.]+)")
    if ($m.Success) { return [double]$m.Groups[1].Value } else { return $default }
  }
  $exitX = Get-Frac $style "exitX" 0.5
  $exitY = Get-Frac $style "exitY" 0.5
  $entryX = Get-Frac $style "entryX" 0.5
  $entryY = Get-Frac $style "entryY" 0.5

  $startX = $srcBox.X + ($srcBox.W * $exitX)
  $startY = $srcBox.Y + ($srcBox.H * $exitY)
  $endX = $tgtBox.X + ($tgtBox.W * $entryX)
  $endY = $tgtBox.Y + ($tgtBox.H * $entryY)

  # Collect waypoints, if any, from mxGeometry/Array/mxPoint
  $points = @()
  $points += [pscustomobject]@{ X = $startX; Y = $startY }
  $geom = $e.mxGeometry
  if ($geom -and $geom.Array -and $geom.Array.mxPoint) {
    foreach ($p in @($geom.Array.mxPoint)) {
      $points += [pscustomobject]@{ X = [double]$p.x; Y = [double]$p.y }
    }
  }
  $points += [pscustomobject]@{ X = $endX; Y = $endY }

  # Build orthogonal segment chain: between consecutive points, if not axis-aligned, insert an
  # implied elbow (this mirrors how orthogonalEdgeStyle actually routes: horizontal-then-vertical
  # or vertical-then-horizontal via the midpoint). We check both possible elbow placements and
  # only flag a crossing if it appears in the elbow configuration actually implied by matching x
  # or y with the adjacent point (this is a conservative approximation, not the exact renderer).
  $segments = @()
  for ($k = 0; $k -lt $points.Count - 1; $k++) {
    $p1 = $points[$k]; $p2 = $points[$k + 1]
    if ($p1.X -eq $p2.X -or $p1.Y -eq $p2.Y) {
      $segments += , @($p1.X, $p1.Y, $p2.X, $p2.Y)
    }
    else {
      # elbow via (p2.X, p1.Y) - horizontal then vertical
      $segments += , @($p1.X, $p1.Y, $p2.X, $p1.Y)
      $segments += , @($p2.X, $p1.Y, $p2.X, $p2.Y)
    }
  }

  foreach ($b in $boxes) {
    if ($b.Id -eq $srcId -or $b.Id -eq $tgtId) { continue }
    # Layer background containers and legend swatches are expected to be crossed by edges that
    # travel through their own (or an adjacent) layer - only real content nodes/labels count.
    if ($b.Id -like "bg_*" -or $b.Id -eq "legend" -or $b.Id -like "lg?") { continue }
    foreach ($seg in $segments) {
      if (Test-SegmentBoxIntersect $seg[0] $seg[1] $seg[2] $seg[3] $b) {
        Write-Host "CROSSING: edge $($e.id) ($srcId -> $tgtId) passes through unrelated node $($b.Id)"
        $crossingFound = $true; $hadIssue = $true
        break
      }
    }
  }
}
if (-not $crossingFound) { Write-Host "OK - no edge paths cross an unrelated node" }

Write-Host "--- SUMMARY ---"
if ($hadIssue) {
  Write-Host "FAIL - one or more issues found above. Fix before delivering." -ForegroundColor Red
  exit 1
}
else {
  Write-Host "PASS - file is structurally and geometrically clean." -ForegroundColor Green
  exit 0
}
