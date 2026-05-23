# config
styles/defaults.json
# query
SELECT
    id,
    name
FROM
    products
WHERE
    category_id IN (
        SELECT
            id
        FROM
            categories
        WHERE
            active = 1
    )