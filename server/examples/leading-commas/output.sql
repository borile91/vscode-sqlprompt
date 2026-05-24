SELECT
    o.order_id
    , o.order_date
    , c.customer_name
    , p.product_name
    , od.quantity
    , od.unit_price
    , od.quantity * od.unit_price AS line_total
FROM orders AS o
INNER JOIN customers AS c
    ON o.customer_id = c.customer_id
INNER JOIN order_details AS od
    ON o.order_id = od.order_id
INNER JOIN products AS p
    ON od.product_id = p.product_id
WHERE
    o.order_date >= '2024-01-01'
    AND o.order_date < '2025-01-01'
    AND c.country = 'USA'
GROUP BY
    o.order_id
    , o.order_date
    , c.customer_name
    , p.product_name
ORDER BY
    o.order_date DESC
    , c.customer_name ASC
