# Local Secrets Detection & Highlighting Issues Analysis

## Problems Identified

### Issue 1: Local Secrets Not Detected Near Apiiro Risks
**Root Cause**: Over-aggressive line-level deduplication in `mergeRisksWithDeduplication()`
- The current logic removes ALL local secrets from lines that have ANY Apiiro risk
- This is too broad - it should only remove local secrets that are actually duplicates
- Line 86-96 in enhanced-diff-service.ts: `apiiroRiskLines.has(localLineNumber)` removes all local secrets

### Issue 2: Apiiro Risks Getting Local Colors  
**Root Cause**: Bug in `applyEnhancedInlineHighlights()` decoration logic
- Line 295-302: When creating Apiiro decoration, it passes `risks` (all risks) instead of just `apiiroRisks`
- This causes mixed hover messages and potential decoration conflicts
- The `isLocal` parameter logic is inconsistent

### Issue 3: Deduplication Rules Too Strict
**Root Cause**: Fuzzy matching rules are removing valid separate detections
- Line 207-211: ±2 line rule with exact content match might remove nearby legitimate secrets
- Line 220-227: ±3 line rule with 70% similarity is too aggressive
- These rules assume all nearby secrets are duplicates, which isn't always true

## Solution Options

### Option A: Conservative Fix (Recommended)
**Approach**: Minimal changes, focus on fixing bugs without changing core logic

1. **Fix Line-Level Deduplication**
   - Only remove local secrets if they're on the EXACT same line as Apiiro secrets
   - Remove the nearby line rules (±2, ±3) entirely for now
   - Keep only exact line + content matching

2. **Fix Decoration Bug**
   - Pass only `apiiroRisks` to Apiiro decorations, not all risks
   - Ensure local and Apiiro decorations never overlap on same line
   - Fix hover message generation

3. **Simplify Deduplication Rules**
   - Keep only: exact line+content match, same line+high similarity (>90%)
   - Remove fuzzy line matching temporarily

### Option B: Sophisticated Fix
**Approach**: Redesign the deduplication system entirely

1. **Smart Line-Level Deduplication**
   - Instead of removing all local secrets from Apiiro lines, compare each pair
   - Use content similarity to determine if they're actually the same secret
   - Allow multiple different secrets on the same line

2. **Advanced Decoration System**
   - Create compound decorations for lines with both types
   - Use different visual indicators (underline style, border, etc.)
   - Implement priority-based decoration selection

3. **Enhanced Deduplication Rules**
   - Add secret type classification (API key, password, token, etc.)
   - Only deduplicate secrets of the same type
   - Use fuzzy matching only within same secret types
   - Add confidence thresholds per rule type

### Option C: Hybrid Approach
**Approach**: Conservative core with selective enhancements

1. **Fix Critical Bugs First** (from Option A)
   - Fix decoration assignment bug
   - Fix line-level deduplication bug

2. **Add Smart Content Comparison**
   - When local and Apiiro secrets are on same line, compare content
   - Only remove local if similarity > 95% AND same secret type
   - Log all deduplication decisions for debugging

3. **Improve Visual Distinction**
   - Ensure local decorations always use purple/magenta colors
   - Add tooltip indicators to distinguish sources
   - Fix hover message separation

## ❌ CURRENT ISSUE: Apiiro Risks Being Filtered

**Problem**: Apiiro risks are being filtered out if lines have changed/moved, which is wrong.
- Apiiro risks should ALWAYS show (they're authoritative)
- Line change detection should only affect positioning, not filtering
- Current logic skips Apiiro risks on changed lines

## 🔄 PLANNED REFACTOR: Two-Phase Approach

### Phase 1: Position Apiiro Risks (Authoritative)
**Goal**: Handle ALL Apiiro risks first, never filter them

1. **Take ALL Apiiro Risks** (never filter any out)
2. **Apply Line Mapping** for positioning:
   - If line unchanged → show on original line
   - If line moved → show on new line position  
   - If line deleted/changed → show on original line anyway (user needs to see it)
3. **Create Positioned Apiiro Risk Map**: `Map<lineNumber, ApiiroRisk[]>`

### Phase 2: Add Local Secrets (Supplementary)
**Goal**: Add local secrets only where they don't conflict

1. **Take ALL Local Secrets** from scanner
2. **Apply Line Validation**:
   - Only show if line content still matches what was scanned
   - Skip if line was deleted/changed significantly
3. **Apply Conflict Resolution**:
   - If Positioned Apiiro Risk exists on same line → skip local secret
   - Otherwise → add local secret to final map
4. **Merge into Final Risk Map**: `Map<lineNumber, Risk[]>`

### Key Principles

**For Apiiro Risks (Phase 1)**:
- ✅ **Never filter out** - always show all Apiiro risks
- ✅ **Smart positioning** - follow line moves, show on best available line
- ✅ **Authoritative** - these are from server, always trust them

**For Local Secrets (Phase 2)**:
- ✅ **Validate content** - only show if line content still matches
- ✅ **Conflict avoidance** - don't show on lines with Apiiro risks
- ✅ **Supplementary** - fill gaps where Apiiro doesn't have coverage

### Expected Behavior After Refactor
- ✅ **All Apiiro risks visible** (never filtered, only repositioned)
- ✅ **Local secrets as gap-fillers** (only on lines without Apiiro risks)
- ✅ **Smart line following** (risks follow code when it moves)
- ✅ **Robust against changes** (Apiiro risks always show somewhere)

### Implementation Steps
1. **Split `groupRisksByLine` into two methods**:
   - `positionApiiroRisks(apiiroRisks, lineMapping)` 
   - `addLocalSecrets(localSecrets, lineMapping, apiiroPositions)`
2. **Update `mergeRisksWithDeduplication`** to call both phases
3. **Remove all Apiiro risk filtering logic**
4. **Keep local secret validation but make it stricter** 

# Local Secrets Deduplication Issues - Debugging Notes

## 🚨 Potential Issues Identified

### 1. **ID Collision Risk** 
**Location**: `src/services/on-demand-secrets-service.ts:148`
```typescript
// Multiple secrets on same line could generate identical IDs
id: crypto.createHash('md5').update(`${filePath}-${item.lineNumber}-${item.previewLine}`).digest('hex'),
```
**Problem**: If two secrets have similar preview content on the same line, they could get identical IDs.
**Impact**: One secret could overwrite another in any Map/Set operations.

### 2. **Local Secrets Self-Interference**
**Location**: `src/services/enhanced-diff-service.ts:395-449`
**Current Logic**: Local secrets are processed sequentially and only checked against remote risks.
**Potential Issue**: Multiple local secrets on same line might interfere with each other.
**Question**: Are local secrets accidentally deduplicating themselves?

### 3. **Line Mapping Edge Cases**
**Location**: `src/services/enhanced-diff-service.ts:115-222`
**Scenario**: When multiple local secrets exist on the same line that has moved/changed:
```typescript
// Handle local secrets that might be on new lines
for (const localSecret of localSecrets) {
  const lineNum = localSecret.sourceCode.lineNumber;
  
  if (!mapping.has(lineNum)) {
    // Create new mapping
  } else {
    // Mark existing mapping as having local risk
    const existing = mapping.get(lineNum)!;
    existing.localOnlyRisk = true; // ❓ Does this overwrite individual secrets?
  }
}
```

### 4. **Text Change Handler Bug** ✅ FIXED
**Location**: `src/extension.ts:175-183`
**Problem**: `removeAllHighlights()` was clearing local secrets during text changes.
**Status**: Fixed by removing unnecessary `removeAllHighlights()` call.

## 🔍 Debugging Questions

1. **Are multiple local secrets on the same line being preserved?**
   - Test: Add 2+ different secrets to same line
   - Expected: All should appear
   - Check: Final merged risks Map

2. **Are local secret IDs truly unique?**
   - Test: Multiple secrets with similar content on same line
   - Check: Do they generate different IDs?

3. **Is line mapping affecting local secret positioning?**
   - Test: Local secrets on moved lines
   - Check: Are they positioned correctly after diff?

## 🧪 Test Scenarios

### Scenario A: Multiple Local Secrets, Same Line
```python
# Line 417: password = "secret123", api_key = "abc123"
```
**Expected**: Both secrets highlighted
**Current**: Unknown - needs testing

### Scenario B: Local + Remote on Same Line  
```python  
# Line 417: password = "secret123" (local) + API detected secret (remote)
```
**Expected**: Only remote shown (current deduplication logic)
**Current**: Should work correctly

### Scenario C: Local Secrets on Moved Lines
```python
# Original line 417 → moves to line 419 after diff
# password = "secret123"
```
**Expected**: Secret highlighted on new line 419
**Current**: Should work with enhanced diff service

## 🛠️ Potential Solutions

### Quick Fix: Enhanced ID Generation
```typescript
// Make IDs more unique by including more context
id: crypto.createHash('md5').update(`${filePath}-${item.lineNumber}-${item.secretType}-${item.previewLine}-${Date.now()}`).digest('hex'),
```

### Robust Fix: Array-Based Processing
```typescript
// Instead of checking "any remote risk on line", check for exact duplicates
const isDuplicate = existingRisks.some(risk => 
  risk.ruleName === localSecret.ruleName && 
  risk.riskLevel === localSecret.riskLevel
);
```

### Ultimate Fix: Separate Local Highlighting
```typescript
// Completely separate local and remote highlighting systems
// Never mix them in the same data structures
```

## 📊 Current Status
- ✅ Text change interference fixed
- ✅ Enhanced diff runs on every save  
- ❓ Local-local interference needs investigation
- ❓ ID collision needs verification

## 🎯 Next Steps
1. Add comprehensive logging to `addLocalSecretsSimple`
2. Test multiple local secrets on same line
3. Verify ID uniqueness
4. Consider separate highlighting tracks for local vs remote 