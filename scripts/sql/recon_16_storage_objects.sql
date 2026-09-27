select bucket_id, count(*)::int as objects
from storage.objects
group by 1
order by 2 desc;
