# config
styles/defaults.json
# query
SELECT
    u.id,
    u.name,
    o.total
FROM
    users u
    INNER JOIN orders o
        ON u.id = o.user_id
WHERE
    o.status = 1
ORDER BY
    u.name