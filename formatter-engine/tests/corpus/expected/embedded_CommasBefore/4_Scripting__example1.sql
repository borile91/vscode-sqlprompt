use SampleDb_Master;
go
set ansi_nulls on;
go
set quoted_identifier on;
go
create table dbo.TABLE_DETAIL
(
    id int identity(1, 1) not null
  , COL_CODE_A varchar(3) not null
  , col_code_b varchar(3) not null
  , ColGroup varchar(11) not null
  , COL_TYPE varchar(3) not null
  , col_year smallint not null
  , COL_NUM varchar(20) not null
  , COL_ROW varchar(20) not null
  , COL_ITEM varchar(40) not null
  , COL_QTY_A numeric(12, 3) not null
  , col_qty_b numeric(12, 3) not null
  , ColQtyC numeric(12, 3) not null
  , COL_TEXT nvarchar(255) null
  , col_flag_a bit not null
  , ColFlagB bit not null
  , COL_DATE_A datetime not null
  , col_date_b date null
  , ColDateC date null
  , COL_RATIO numeric(9, 3) null
  , COL_PRIORITY int not null
  , constraint PK_TABLE_DETAIL
        primary key clustered (
                                  COL_CODE_A asc
                                , col_code_b asc
                                , ColGroup asc
                                , COL_TYPE asc
                                , col_year asc
                                , COL_NUM asc
                                , COL_ROW asc
                              )
        with (pad_index = off, statistics_norecompute = off, ignore_dup_key = off, allow_row_locks = on
            , allow_page_locks = on, optimize_for_sequential_key = off
             ) on [PRIMARY]
) on [PRIMARY];
go
alter table dbo.TABLE_DETAIL
add constraint DF_TABLE_DETAIL_COL_QTY_A
    default ((0)) for COL_QTY_A;
go
alter table dbo.TABLE_DETAIL
add constraint DF_TABLE_DETAIL_col_qty_b
    default ((0)) for col_qty_b;
go
alter table dbo.TABLE_DETAIL
add constraint DF_TABLE_DETAIL_ColQtyC
    default ((0)) for ColQtyC;
go
alter table dbo.TABLE_DETAIL
add constraint DF_TABLE_DETAIL_col_flag_a
    default ((0)) for col_flag_a;
go
alter table dbo.TABLE_DETAIL
add constraint DF_TABLE_DETAIL_ColFlagB
    default ((0)) for ColFlagB;
go
alter table dbo.TABLE_DETAIL
add constraint DF_TABLE_DETAIL_COL_DATE_A
    default (getdate()) for COL_DATE_A;
go
alter table dbo.TABLE_DETAIL
add constraint DF_TABLE_DETAIL_COL_PRIORITY
    default ((50)) for COL_PRIORITY;
go
alter table dbo.TABLE_DETAIL with check
add constraint FK_TABLE_DETAIL_TABLE_ITEM
    foreign key (COL_ITEM)
    references dbo.TABLE_ITEM (COL_ITEM);
go
alter table dbo.TABLE_DETAIL check constraint FK_TABLE_DETAIL_TABLE_ITEM;
go
alter table dbo.TABLE_DETAIL with check
add constraint FK_TABLE_DETAIL_TABLE_HEADER
    foreign key (
                    COL_CODE_A
                  , col_code_b
                  , ColGroup
                  , COL_TYPE
                  , col_year
                  , COL_NUM
                )
    references dbo.TABLE_HEADER (
                                    COL_CODE_A
                                  , col_code_b
                                  , ColGroup
                                  , COL_TYPE
                                  , col_year
                                  , COL_NUM
                                ) on update cascade on delete cascade;
go
alter table dbo.TABLE_DETAIL check constraint FK_TABLE_DETAIL_TABLE_HEADER;
go
alter table dbo.TABLE_DETAIL with check
add constraint FK_TABLE_DETAIL_AUX_TYPE
    foreign key (COL_TYPE)
    references aux.TABLE_TYPE (COL_TYPE);
go
alter table dbo.TABLE_DETAIL check constraint FK_TABLE_DETAIL_AUX_TYPE;
go
exec sys.sp_addextendedproperty @name = N'MS_Description'
                              , @value = N'Generic detail note for formatter tests.'
                              , @level0type = N'SCHEMA'
                              , @level0name = N'dbo'
                              , @level1type = N'TABLE'
                              , @level1name = N'TABLE_DETAIL'
                              , @level2type = N'COLUMN'
                              , @level2name = N'COL_TEXT';
go
exec sys.sp_addextendedproperty @name = N'MS_Description'
                              , @value = N'Generic quantity for sample records.'
                              , @level0type = N'SCHEMA'
                              , @level0name = N'dbo'
                              , @level1type = N'TABLE'
                              , @level1name = N'TABLE_DETAIL'
                              , @level2type = N'COLUMN'
                              , @level2name = N'COL_RATIO';
go