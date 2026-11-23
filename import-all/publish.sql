UPDATE room SET data = json_set(data, '$.Accessibility', 1) WHERE room_id BETWEEN 64 AND 76;
UPDATE subroom SET data = json_set(data, '$.Accessibility', 1) WHERE room_id BETWEEN 64 AND 76;
