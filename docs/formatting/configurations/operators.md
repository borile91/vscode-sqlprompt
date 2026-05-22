"operators": {
    "andOr": {
      "alignment": "toFirstListItem",
      "placeKeywordBeforeCondition": false
    },
    "between": {
      "placeOnNewLine": false
    },
    "in": {
      "placeFirstValueOnNewLine": "never",
      "placeSubsequentValuesOnNewLines": "never",
      "addSpaceAroundInContents": true
    }
}

# andOr
## placeOnNewLine
### never
SELECT AddressID
FROM   Person.Address
WHERE  ModifiedDate BETWEEN DATEADD(MONTH, -6, GETDATE()) AND GETDATE() AND City = 'Bothell' OR LEFT(PostalCode, 2) = 'CB' OR PostalCode = @prefix + @suffix
### always (default)
SELECT AddressID
FROM   Person.Address
WHERE  ModifiedDate BETWEEN DATEADD(MONTH, -6, GETDATE()) AND GETDATE()
       AND City = 'Bothell'
       OR LEFT(PostalCode, 2) = 'CB'
       OR PostalCode = @prefix + @suffix

## alignment

### toFirstItem
SELECT AddressID
FROM   Person.Address
WHERE  ModifiedDate BETWEEN DATEADD(MONTH, -6, GETDATE()) AND GETDATE()
       AND City = 'Bothell'
       OR LEFT(PostalCode, 2) = 'CB'
       OR PostalCode = @prefix + @suffix

### rightAligned
SELECT AddressID
FROM   Person.Address
WHERE  ModifiedDate BETWEEN DATEADD(MONTH, -6, GETDATE()) AND GETDATE()
  AND  City = 'Bothell'
   OR  LEFT(PostalCode, 2) = 'CB'
   OR  PostalCode = @prefix + @suffix

## placeKeywordBeforeCondition (default true)
### false
SELECT AddressID
FROM   Person.Address
WHERE  ModifiedDate BETWEEN DATEADD(MONTH, -6, GETDATE()) AND GETDATE() AND
       City = 'Bothell' OR
       LEFT(PostalCode, 2) = 'CB' OR
       PostalCode = @prefix + @suffix